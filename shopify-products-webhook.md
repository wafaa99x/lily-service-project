import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createHmac } from "node:crypto";

type ShopifyProduct = {
  id: number | string;
  title: string;
  handle: string;
  images?: Array<{ src?: string }>;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SHOPIFY_WEBHOOK_SECRET = Deno.env.get("SHOPIFY_WEBHOOK_SECRET") || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-shopify-hmac-sha256, x-shopify-topic, x-shopify-shop-domain",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

function safeDbKey(handle: string, fallbackId: string): string {
  const base = (handle || "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (base) return base.slice(0, 50);
  return `product-${fallbackId}`.slice(0, 50);
}

// Verify the X-Shopify-Hmac-Sha256 header. If the secret is missing or the
// signature is invalid, return 401 so spoofed requests can't write to the DB.
function verifyShopifyHmac(rawBody: string, hmacHeader: string | null): boolean {
  if (!SHOPIFY_WEBHOOK_SECRET) return false;
  if (!hmacHeader) return false;
  const computed = createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");
  // timing-safe compare
  if (computed.length !== hmacHeader.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computed.length; i++) {
    mismatch |= computed.charCodeAt(i) ^ hmacHeader.charCodeAt(i);
  }
  return mismatch === 0;
}

function respond(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(),
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }

  if (req.method !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }

  // Read raw body for HMAC verification BEFORE parsing JSON
  const rawBody = await req.text();
  const hmac = req.headers.get("x-shopify-hmac-sha256");
  const topic = req.headers.get("x-shopify-topic");

  if (!verifyShopifyHmac(rawBody, hmac)) {
    console.error("[products-webhook] HMAC verification failed", { topic });
    return respond(401, { error: "Invalid HMAC signature" });
  }

  let payload: ShopifyProduct | null = null;
  try {
    payload = JSON.parse(rawBody);
  } catch (_) {
    return respond(400, { error: "Invalid JSON payload" });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return respond(500, { error: "Missing Supabase environment variables" });
  }

  try {
    // ── Handle product deletion: topic = "products/delete" ─────────────
    if (topic === "products/delete") {
      const shopifyProductId = String((payload as unknown as { id: number | string }).id);
      const { error } = await supabase
        .from("products")
        .update({ is_active: false })
        .eq("shopify_product_id", shopifyProductId);
      if (error) {
        console.error("[products-webhook] soft-delete failed", error);
        return respond(500, { error: error.message });
      }
      return respond(200, { ok: true, action: "soft-deleted", shopify_product_id: shopifyProductId });
    }

    // ── Handle product create/update: topics "products/create", "products/update" ──
    const p = payload as ShopifyProduct;
    if (!p || !p.id) {
      return respond(400, { error: "Missing product id" });
    }

    const shopifyProductId = String(p.id);
    const dbKey = safeDbKey(String(p.handle || ""), shopifyProductId);

    const record = {
      id: dbKey,
      name: String(p.title || dbKey),
      shopify_product_id: shopifyProductId,
      shopify_handle: String(p.handle || ""),
      shopify_image: p.images?.[0]?.src || null,
      is_active: true,
    };

    const { data, error } = await supabase
      .from("products")
      .upsert(record, { onConflict: "shopify_product_id", ignoreDuplicates: false })
      .select();

    if (error) {
      console.error("[products-webhook] upsert failed", error);
      return respond(500, { error: error.message });
    }

    console.log("[products-webhook] upserted", { topic, shopify_product_id: shopifyProductId, dbKey });
    return respond(200, { ok: true, action: "upserted", product: data?.[0] || record });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    console.error("[products-webhook] error", message);
    return respond(500, { error: message });
  }
});