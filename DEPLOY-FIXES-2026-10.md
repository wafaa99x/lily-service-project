# Bug-fix release (2026-10) — where to deploy each change

The booking flow is unchanged: product page (date + slot) → Add to cart →
cart page (delivery area) → Shopify checkout → paid-order webhook → booking.
These changes only remove bugs and security holes.

Do the steps **in this order**. Step 4 must come after step 3, or the old
widget will briefly show every slot as free.

## 1. Supabase — SQL (PART A)
Supabase → SQL Editor → paste **PART A** of `supabase-migration-2026-10.sql` → Run.
Safe to run while the shop is live. It:
- lets a cancelled booking's slot be booked again (old UNIQUE counted cancelled rows)
- re-checks capacity when a cancelled booking is re-activated
- allows editing an active booking's details inside the 24h window
- uses Kuwait date for the "past date" rule
- cascades product id changes (Shopify handle rename no longer breaks product sync)
- adds the `booking_slots` view (no customer data) and the `availability_ping` realtime signal
- links Dafwa ↔ Naseem rows and hides the 6 placeholder products

## 2. Supabase — Edge Function `shopify-order-webhook`
Replace the function code with `shopify-order-webhook.md` (it is TypeScript):
- Dashboard → Edge Functions → shopify-order-webhook → paste → Deploy, **or**
- CLI: copy to `supabase/functions/shopify-order-webhook/index.ts`, then
  `npx supabase functions deploy shopify-order-webhook --no-verify-jwt --project-ref adcjzrstjrdxzfobcfbl`

No new secrets. Fixes:
- paid orders that can't be booked are now written to `booking_rejections` (admin refund alert)
- duplicate deliveries (orders/create + orders/paid, Shopify retries) no longer count as failures
- saves delivery governorate / area / fee on the booking
- reads the new hidden `_bk_date` / `_bk_slot` properties (old orders still parse)
- quantity > 1 books one unit and flags the extra units as a rejection

## 3. Shopify — theme files (duplicate the live theme first, test, then publish)
Online Store → Themes → … → Edit code:

| Repo file | Theme file | What changes |
|---|---|---|
| `booking-widget-v2.html` | `snippets/booking-system.liquid` | replace whole file |
| `Cart-v.md` | `assets/cart-v.js` | replace whole file |
| `backup.js` | `layout/theme.liquid` — the `<script>` block between `{% comment %} To add Delivery Based on Area {% endcomment %}` and `{% comment %} END {% endcomment %}` | replace that script block only |

Widget fixes: availability is checked **before** the item is added (the theme
was adding it first); no false "already in your cart" error; quantity fixed at 1;
24h rule uses Kuwait time; works on every booking product (no hard-coded id);
linked-product fallback works; reads availability without customer data.

Cart guard fixes: also checks linked product, admin-blocked slots, the 24h rule
and quantity; no endless re-validation loop; product tags cached.

Delivery script fixes: saves governorate/area on the cart (they were lost);
no JavaScript error on non-cart pages.

## 4. Supabase — SQL (PART B)
After the new theme is published: run **PART B** of the migration. It removes
public read access to `bookings` and `booking_rejections` (names, phones,
emails were readable with the public key in the widget).

## 5. Render — redeploy `server.js`
Push to the branch Render deploys (or Manual Deploy). No new env vars
(optional `TRUST_PROXY_HOPS`, default 1). Fixes:
- only `index.html` and `admin-panel.html` are served (source/SQL/docs were public)
- login lockout uses Render's real client IP (a fake `X-Forwarded-For` bypassed it)
- constant-time password / token comparison

## Fresh installs
`supabase-schema.sql` now includes all of the above (and a fix for the
`uq_products_shopify_product_id` error that stopped it running on a new DB).

## Not in this repo
`shopify-orders-sync` (Edge Function used by the admin "sync orders" button and
the 90-second catch-up) is not in the repo, so it was not reviewed. If it also
inserts bookings, it needs the same idempotency/rejection handling.
