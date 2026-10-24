import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type ShopifyProp = { name?: string; value?: string };

type ShopifyLineItem = {
  id?: number | string;
  product_id?: number | string;
  title?: string;
  quantity?: number;
  price?: string;
  properties?: ShopifyProp[];
};

type ShopifyOrder = {
  id?: number | string;
  name?: string;
  email?: string;
  phone?: string;
  financial_status?: string;
  fulfillment_status?: string | null;
  cancelled_at?: string | null;
  note_attributes?: ShopifyProp[];
  customer?: {
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
  };
  shipping_address?: { phone?: string } | null;
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

function getProp(props: ShopifyProp[] | undefined, name: string): string | null {
  if (!props) return null;
  const hit = props.find((p) => String(p?.name || "").trim().toLowerCase() === name.toLowerCase());
  return safeStr(hit?.value);
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// Turns the widget's date into 'YYYY-MM-DD' without any timezone shifting.
// Accepts "2026-10-24" (hidden _bk_date property) or the visible
// "Saturday, 24 October 2026" (📅 Date property).
function parseDate(dateVal: string | null): string | null {
  if (!dateVal) return null;
  const iso = dateVal.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = dateVal.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (dmy) {
    const m = MONTHS[dmy[2].toLowerCase()];
    if (m) return `${dmy[3]}-${String(m).padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  }
  return null;
}

function parseSlot(slotVal: string | null): string | null {
  const s = (slotVal || "").toLowerCase();
  if (!s) return null;
  if (s === "morning" || s === "evening") return s;
  if (s.includes("evening") || s.includes("2:30") || s.includes("14:30") || s.includes("pm")) return "evening";
  if (s.includes("morning") || s.includes("6:30") || s.includes("am")) return "morning";
  return null;
}

function parseDateSlot(li: ShopifyLineItem): { date: string; slot: string } | null {
  const date = parseDate(getProp(li.properties, "_bk_date")) ||
    parseDate(getProp(li.properties, "📅 Date") || getProp(li.properties, "Date"));
  const slot = parseSlot(getProp(li.properties, "_bk_slot")) ||
    parseSlot(getProp(li.properties, "⏰ Slot") || getProp(li.properties, "Slot"));
  if (!date || !slot) return null;
  return { date, slot };
}

// Delivery details: the cart page adds a "Delivery Fee …" product and saves
// the chosen governorate/area as cart attributes (→ order.note_attributes).
function getDelivery(order: ShopifyOrder) {
  const governorate = getProp(order.note_attributes, "Delivery Governorate");
  const area = getProp(order.note_attributes, "Delivery Area");
  let price: number | null = null;
  for (const li of order.line_items || []) {
    if (/delivery\s*fee/i.test(String(li.title || ""))) {
      const p = Number(li.price);
      if (!Number.isNaN(p)) price = (price || 0) + p * Number(li.quantity || 1);
    }
  }
  return { delivery_governorate: governorate, delivery_area: area, delivery_price: price };
}

type Rejection = {
  shopify_order_id: string;
  order_name: string | null;
  product_id: string | null;
  product_name: string | null;
  booking_date: string | null;
  slot: string | null;
  reason: string;
  customer_email: string | null;
  customer_name: string | null;
  customer_phone: string | null;
};

// Records a paid order that could not be booked, so the admin panel flags it
// for a refund. Skips duplicates caused by webhook retries / create+paid.
async function recordRejection(r: Rejection) {
  let q = supabase
    .from("booking_rejections")
    .select("id")
    .eq("shopify_order_id", r.shopify_order_id)
    .limit(1);
  q = r.product_id ? q.eq("product_id", r.product_id) : q.is("product_id", null);
  q = r.booking_date ? q.eq("booking_date", r.booking_date) : q.is("booking_date", null);
  q = r.slot ? q.eq("slot", r.slot) : q.is("slot", null);
  const { data: existing } = await q;
  if (existing && existing.length) return;
  const { error } = await supabase.from("booking_rejections").insert(r);
  if (error) console.error("[order-webhook] could not record rejection", error);
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
    // Bookings are kept for history; is_active=false frees the slot.
    if (topic === "orders/cancelled") {
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
    // Bookings are created only for paid orders (unchanged flow).
    const isPaid = order.financial_status === "paid";
    if (topic === "orders/create" && !isPaid) {
      return respond(200, { ok: true, action: "skipped-unpaid", shopify_order_id: shopifyOrderId });
    }
    if (order.cancelled_at) {
      return respond(200, { ok: true, action: "skipped-cancelled", shopify_order_id: shopifyOrderId });
    }

    const customerName = [order.customer?.first_name, order.customer?.last_name]
      .filter(Boolean)
      .join(" ")
      .trim() || null;
    const customerEmail = safeStr(order.customer?.email || order.email);
    const customerPhone = safeStr(order.customer?.phone || order.phone || order.shipping_address?.phone);
    const delivery = getDelivery(order);

    const results: Array<{ line_item_id: string; status: string; booking_id?: string; reason?: string }> = [];

    const shopifyProductIds = Array.from(
      new Set(
        (order.line_items || [])
          .map((li) => String(li.product_id || ""))
          .filter(Boolean),
      ),
    );
    const productMap = new Map<string, { id: string; name: string | null }>();
    if (shopifyProductIds.length) {
      const { data: products, error: productsError } = await supabase
        .from("products")
        .select("id, name, shopify_product_id")
        .in("shopify_product_id", shopifyProductIds);
      if (productsError) throw new Error(productsError.message);
      (products || []).forEach((p) => {
        if (p.shopify_product_id) productMap.set(String(p.shopify_product_id), { id: p.id, name: p.name });
      });
    }

    let insertedRows = 0;

    for (const li of order.line_items || []) {
      const liId = String(li.id ?? `${shopifyOrderId}-${li.product_id ?? li.title}`);

      // Only line items carrying a booking date/slot are bookings
      // (delivery fees and add-ons are skipped quietly).
      const parsed = parseDateSlot(li);
      if (!parsed) {
        results.push({ line_item_id: liId, status: "skipped", reason: "no booking date/slot" });
        continue;
      }

      const rejectionBase = {
        shopify_order_id: shopifyOrderId,
        order_name: safeStr(order.name),
        booking_date: parsed.date,
        slot: parsed.slot,
        customer_email: customerEmail,
        customer_name: customerName,
        customer_phone: customerPhone,
      };

      const shopifyProductId = safeStr(li.product_id);
      const product = shopifyProductId ? productMap.get(shopifyProductId) : null;
      if (!product) {
        await recordRejection({
          ...rejectionBase,
          product_id: null,
          product_name: safeStr(li.title),
          reason: "Product not found in booking system (run product sync)",
        });
        results.push({ line_item_id: liId, status: "rejected", reason: "product not in DB" });
        continue;
      }

      // Idempotency: create + paid + Shopify retries all deliver the same order.
      const { data: existing, error: existingError } = await supabase
        .from("bookings")
        .select("id")
        .eq("shopify_order_id", shopifyOrderId)
        .eq("product_id", product.id)
        .eq("booking_date", parsed.date)
        .eq("slot", parsed.slot)
        .limit(1);
      if (existingError) throw new Error(existingError.message);

      if (existing && existing.length) {
        // Already booked by an earlier delivery — just fill in delivery details if missing.
        await supabase
          .from("bookings")
          .update(delivery)
          .eq("id", existing[0].id)
          .is("delivery_area", null);
        results.push({ line_item_id: liId, status: "already-booked", booking_id: existing[0].id });
      } else {
        const row = {
          product_id: product.id,
          booking_date: parsed.date,
          slot: parsed.slot,
          customer_name: customerName,
          customer_phone: customerPhone,
          customer_email: customerEmail,
          shopify_order_id: shopifyOrderId,
          notes: `Order ${order.name || shopifyOrderId}`,
          ...delivery,
        };
        const { data, error } = await supabase
          .from("bookings")
          .insert(row)
          .select("id")
          .maybeSingle();
        if (error) {
          // 23505 = unique violation from a concurrent duplicate delivery.
          if (error.code === "23505" && /shopify_order/.test(error.message)) {
            results.push({ line_item_id: liId, status: "already-booked" });
          } else {
            await recordRejection({
              ...rejectionBase,
              product_id: product.id,
              product_name: product.name || safeStr(li.title),
              reason: error.message,
            });
            results.push({ line_item_id: liId, status: "rejected", reason: error.message });
          }
          continue;
        }
        insertedRows += 1;
        results.push({ line_item_id: liId, status: "inserted", booking_id: data?.id });
      }

      // A product can hold a slot only once, so extra units can't be booked.
      const qty = Number(li.quantity || 1);
      if (qty > 1) {
        await recordRejection({
          ...rejectionBase,
          product_id: product.id,
          product_name: product.name || safeStr(li.title),
          reason: `Quantity ${qty}: only 1 can be booked per product per slot (${qty - 1} extra)`,
        });
      }
    }

    console.log("[order-webhook]", { topic, shopify_order_id: shopifyOrderId, insertedRows });
    return respond(200, { ok: true, action: "processed", shopify_order_id: shopifyOrderId, results });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unexpected error";
    console.error("[order-webhook] error", message);
    // 500 makes Shopify retry later; retries are safe (idempotent).
    return respond(500, { error: message });
  }
});
