import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type ShopifyLineItem = {
  id?: number | string;
  product_id?: number | string;
  title?: string;
  quantity?: number;
  properties?: Array<{ name?: string; value?: string }>;
};

type ShopifyOrder = {
  id?: number | string;
  name?: string;
  email?: string;
  phone?: string;
  financial_status?: string;
  fulfillment_status?: string | null;
  cancelled_at?: string | null;
  customer?: {
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
  };
  line_items?: ShopifyLineItem[];
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SHOPIFY_WEBHOOK_SECRET =
  Deno.env.get("SHOPIFY_ORDER_WEBHOOK_SECRET") ||
  Deno.env.get("SHOPIFY_PRODUCTS_WEBHOOK_SECRET") ||
  Deno.env.get("SHOPIFY_WEBHOOK_SECRET") ||
  "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-shopify-hmac-sha256, x-shopify-topic, x-shopify-shop-domain",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  const bytes = new Uint8Array(sig);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function verifyShopifyHmac(rawBody: string, provided: string | null): Promise<boolean> {
  if (!SHOPIFY_WEBHOOK_SECRET || !provided) return false;
  const computed = await hmacSha256Base64(SHOPIFY_WEBHOOK_SECRET, rawBody);
  return timingSafeEqual(computed, provided);
}

function respond(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() });
}

function safeStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function getProp(props: Array<{ name?: string; value?: string }> | undefined, name: string): string | null {
  if (!props) return null;
  const hit = props.find((p) => String(p?.name || "").trim().toLowerCase() === name.toLowerCase());
  return safeStr(hit?.value);
}

// Parse the "Date (6:30 AM – 8:30 AM)" style slot strings coming from the widget.
// Returns { date: 'YYYY-MM-DD', slot: 'morning'|'evening' } or null.
function parseDateSlot(dateVal: string | null, slotVal: string | null): { date: string; slot: string } | null {
  if (!dateVal) return null;
  // Accept either "2026-08-15" or "Monday, 15 August 2026" — try direct parse first.
  let isoMatch = dateVal.match(/(\d{4})-(\d{2})-(\d{2})/);
  let date = isoMatch ? `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}` : null;
  if (!date) {
    const parsed = new Date(dateVal);
    if (!isNaN(parsed.getTime())) {
      date = parsed.toISOString().slice(0, 10);
    }
  }
  if (!date) return null;

  let slot = "morning";
  const s = (slotVal || "").toLowerCase();
  if (s.includes("evening") || s.includes("2:30") || s.includes("14:30") || s.includes("pm")) slot = "evening";
  else if (s.includes("morning") || s.includes("6:30") || s.includes("am")) slot = "morning";

  return { date, slot };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  if (req.method !== "POST") return respond(405, { error: "Method not allowed" });

  const rawBody = await req.text();
  const hmac = req.headers.get("x-shopify-hmac-sha256");
  const topic = req.headers.get("x-shopify-topic");

  if (!(await verifyShopifyHmac(rawBody, hmac))) {
    console.error("[order-webhook] HMAC verification failed", { topic });
    return respond(401, { error: "Invalid HMAC signature" });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return respond(500, { error: "Missing Supabase environment variables" });
  }

  let order: ShopifyOrder;
  try {
    order = JSON.parse(rawBody);
  } catch {
    return respond(400, { error: "Invalid JSON payload" });
  }

  const shopifyOrderId = String(order.id || order.name || "");
  if (!shopifyOrderId) return respond(400, { error: "Missing order id" });

  try {
    // ── orders/cancelled ─────────────────────────────────────────────
    if (topic === "orders/cancelled") {
      // Mark bookings as inactive if linked to this order. We don't delete
      // because you may want to keep history; capacity is restored by
      // setting is_active=false on the booking rows.
      const { error } = await supabase
        .from("bookings")
        .update({ is_active: false })
        .eq("shopify_order_id", shopifyOrderId);
      if (error) {
        console.error("[order-webhook] cancel failed", error);
        return respond(500, { error: error.message });
      }
      return respond(200, { ok: true, action: "cancelled", shopify_order_id: shopifyOrderId });
    }

    // ── orders/create, orders/paid ───────────────────────────────────
    // Only insert bookings when the order is paid (or being created as paid).
    // Shopify sends orders/create for every order, including unpaid ones —
    // for those, we just record the order presence and wait for orders/paid.
    const isPaid = order.financial_status === "paid";
    if (topic === "orders/create" && !isPaid) {
      return respond(200, { ok: true, action: "skipped-unpaid", shopify_order_id: shopifyOrderId });
    }

    const customerName = [order.customer?.first_name, order.customer?.last_name]
      .filter(Boolean)
      .join(" ")
      .trim() || null;
    const customerEmail = safeStr(order.customer?.email || order.email);
    const customerPhone = safeStr(order.customer?.phone || order.phone);

    const results: Array<{ line_item_id: string; status: string; booking_id?: string; reason?: string }> = [];

    // Resolve all products referenced by line items in one query.
    const shopifyProductIds = Array.from(
      new Set(
        (order.line_items || [])
          .map((li) => String(li.product_id || ""))
          .filter(Boolean),
      ),
    );
    const productMap = new Map<string, { id: string; linked_product_id: string | null }>();
    if (shopifyProductIds.length) {
      const { data: products } = await supabase
        .from("products")
        .select("id, shopify_product_id, linked_product_id")
        .in("shopify_product_id", shopifyProductIds);
      (products || []).forEach((p) => {
        if (p.shopify_product_id) productMap.set(String(p.shopify_product_id), p);
      });
    }

    let pendingRows = 0;
    let insertedRows = 0;

    for (const li of order.line_items || []) {
      const liId = String(li.id ?? `${shopifyOrderId}-${li.product_id ?? li.title ?? Math.random()}`);
      const shopifyProductId = safeStr(li.product_id);
      const product = shopifyProductId ? productMap.get(shopifyProductId) : null;

      if (!product) {
        results.push({ line_item_id: liId, status: "skipped", reason: "product not in DB" });
        continue;
      }

      const dateProp = getProp(li.properties, "📅 Date") || getProp(li.properties, "Date");
      const slotProp = getProp(li.properties, "⏰ Slot") || getProp(li.properties, "Slot");
      const parsed = parseDateSlot(dateProp, slotProp);
      if (!parsed) {
        results.push({ line_item_id: liId, status: "skipped", reason: "missing/invalid date or slot" });
        continue;
      }

      const qty = Number(li.quantity || 1);
      // Insert one row per quantity unit (a single order can carry multiple of the same slot).
      for (let i = 0; i < qty; i++) {
        const row = {
          product_id: product.id,
          booking_date: parsed.date,
          slot: parsed.slot,
          customer_name: customerName,
          customer_phone: customerPhone,
          customer_email: customerEmail,
          shopify_order_id: shopifyOrderId,
          notes: `Order ${order.name || shopifyOrderId}`,
        };
        pendingRows += 1;
        // The DB trigger blocks >3 per slot and rejects duplicates, so we
        // catch the error and report instead of aborting the whole order.
        const { data, error } = await supabase
          .from("bookings")
          .insert(row)
          .select("id")
          .maybeSingle();
        if (error) {
          results.push({ line_item_id: liId, status: "rejected", reason: error.message });
        } else {
          insertedRows += 1;
          results.push({ line_item_id: liId, status: "inserted", booking_id: data?.id });
        }
      }
    }

    console.log("[order-webhook]", { topic, shopify_order_id: shopifyOrderId, pendingRows, insertedRows });
    return respond(200, { ok: true, action: "processed", shopify_order_id: shopifyOrderId, results });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unexpected error";
    console.error("[order-webhook] error", message);
    return respond(500, { error: message });
  }
});