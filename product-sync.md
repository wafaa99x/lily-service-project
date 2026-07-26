import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type ShopifyProduct = {
  id: number | string;
  title: string;
  handle: string;
  images?: Array<{ src?: string }>;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

function safeDbKey(handle: string, fallbackId: string): string {
  const base = (handle || "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (base) return base.slice(0, 50);
  return `product-${fallbackId}`.slice(0, 50);
}

function validShopifyDomain(domain: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(domain.trim());
}

// Fetch ALL products from Shopify, following the Link-Rel="next" header for pagination.
// The previous version only fetched the first 250 (no cursor), so anything past page 1
// was silently dropped — that is why "some products are not being fetched".
async function fetchAllShopifyProducts(domain: string, token: string): Promise<ShopifyProduct[]> {
  const all: ShopifyProduct[] = [];
  let url: string | null =
    `https://${domain}/admin/api/2024-01/products.json?limit=250&fields=id,title,handle,images`;
  let pageCount = 0;
  const MAX_PAGES = 20; // safety cap (5000 products)

  while (url && pageCount < MAX_PAGES) {
    pageCount += 1;
    const res: Response = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const details = await res.text();
      throw new Error(`Shopify API error ${res.status}: ${details.slice(0, 300)}`);
    }

    const payload = await res.json();
    const page: ShopifyProduct[] = Array.isArray(payload?.products) ? payload.products : [];
    all.push(...page);

    // Parse Link header for rel="next"
    const linkHeader = res.headers.get("link") || res.headers.get("Link") || "";
    let nextUrl: string | null = null;
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/i);
    if (nextMatch) {
      const candidate = nextMatch[1];
      // Shopify returns the next URL with our limit/fields already appended; keep them.
      nextUrl = candidate;
    }
    url = nextUrl;
  }

  return all;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return new Response(JSON.stringify({ error: "Missing Supabase environment variables" }), {
        status: 500,
        headers: corsHeaders(),
      });
    }

    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: corsHeaders(),
      });
    }

    const body = await req.json().catch(() => null);
    const domain = String(body?.domain || "").trim();
    const token = String(body?.token || "").trim();

    if (!domain || !token) {
      return new Response(JSON.stringify({ error: "Domain and token are required" }), {
        status: 400,
        headers: corsHeaders(),
      });
    }

    if (!validShopifyDomain(domain)) {
      return new Response(JSON.stringify({ error: "Invalid Shopify domain format" }), {
        status: 400,
        headers: corsHeaders(),
      });
    }

    // 1. Fetch ALL products (paginated). Variants are NOT included because we limited
    //    the fields to id/title/handle/images, so each Shopify product becomes exactly
    //    one row in our `products` table — no more variant-as-product duplicates.
    const products = await fetchAllShopifyProducts(domain, token);

    if (!products.length) {
      return new Response(JSON.stringify({ synced: 0, skipped: 0, products: [] }), {
        status: 200,
        headers: corsHeaders(),
      });
    }

    // 2. Build records. Keep `id` (handle) so admins can keep their existing keys,
    //    but dedupe by `shopify_product_id` so the unique index can never trip.
    const seen = new Set<string>();
    const records: Array<Record<string, unknown>> = [];
    const issues: Array<{ shopify_product_id: string; reason: string }> = [];

    for (const p of products) {
      try {
        const shopifyProductId = String(p.id);
        if (seen.has(shopifyProductId)) {
          issues.push({ shopify_product_id: shopifyProductId, reason: "duplicate in Shopify response" });
          continue;
        }
        seen.add(shopifyProductId);

        const dbKey = safeDbKey(String(p.handle || ""), shopifyProductId);
        records.push({
          id: dbKey,
          name: String(p.title || dbKey),
          shopify_product_id: shopifyProductId,
          shopify_handle: String(p.handle || ""),
          shopify_image: p.images?.[0]?.src || null,
          is_active: true,
        });
      } catch (rowErr) {
        issues.push({
          shopify_product_id: String(p?.id ?? "?"),
          reason: rowErr instanceof Error ? rowErr.message : "row build failed",
        });
      }
    }

    // 3. Upsert in batches, scoped to the products table's REAL unique index
    //    (`shopify_product_id`). The previous version conflicted on `id` only,
    //    which left the unique index free to reject duplicates and throw
    //    `duplicate key value violates unique constraint "uq_products_shopify_product_id"`.
    const BATCH = 100;
    let synced = 0;
    let skipped = 0;

    for (let i = 0; i < records.length; i += BATCH) {
      const slice = records.slice(i, i + BATCH);
      const { error: upsertError } = await supabase
        .from("products")
        .upsert(slice, { onConflict: "shopify_product_id", ignoreDuplicates: false });

      if (upsertError) {
        // Fall back to per-row upsert so one bad row doesn't sink the whole batch.
        for (const row of slice) {
          const { error: singleErr } = await supabase
            .from("products")
            .upsert(row, { onConflict: "shopify_product_id", ignoreDuplicates: false });
          if (singleErr) {
            skipped += 1;
            issues.push({
              shopify_product_id: String(row.shopify_product_id),
              reason: singleErr.message,
            });
          } else {
            synced += 1;
          }
        }
      } else {
        synced += slice.length;
      }
    }

    return new Response(JSON.stringify({
      synced,
      skipped,
      issues: issues.slice(0, 25),
      products: records,
    }), {
      status: 200,
      headers: corsHeaders(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: corsHeaders(),
    });
  }
});