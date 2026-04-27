# Shopify -> Supabase Event-Driven Sync

This setup writes paid Shopify orders into `bookings` and keeps `products` synced in real time using Shopify webhooks.

## 1. Apply schema updates
Run `supabase-schema.sql` again in Supabase SQL Editor.

It now includes:
- booking query indexes for faster widget availability checks
- unique webhook dedupe constraint on `(shopify_order_id, product_id, booking_date, slot)`

## 2. Deploy the Edge Functions
Function sources:
- `supabase/functions/shopify-orders-paid/index.ts`
- `supabase/functions/shopify-products-webhook/index.ts`

Deploy with Supabase CLI from your project root:

```bash
supabase functions deploy shopify-orders-paid
supabase functions deploy shopify-products-webhook
```

## 3. Set required function secrets
Set these in Supabase:

```bash
supabase secrets set SUPABASE_URL="https://<project-ref>.supabase.co"
supabase secrets set SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"
supabase secrets set SHOPIFY_WEBHOOK_SECRET="<shopify-webhook-signing-secret>"
supabase secrets set SHOPIFY_PRODUCTS_WEBHOOK_SECRET="<products-webhook-signing-secret>"
```

If you use one shared Shopify webhook secret for all topics, setting only `SHOPIFY_WEBHOOK_SECRET` is enough.

## 4. Create Shopify webhooks
In Shopify admin:
- Settings -> Notifications -> Webhooks -> Create webhook
- Event: `Order payment` (`orders/paid`)
- Format: `JSON`
- URL: `https://<project-ref>.functions.supabase.co/shopify-orders-paid`
- Save

Create 3 more webhooks for products:
- Event: `Product creation` (`products/create`) -> `https://<project-ref>.functions.supabase.co/shopify-products-webhook`
- Event: `Product update` (`products/update`) -> `https://<project-ref>.functions.supabase.co/shopify-products-webhook`
- Event: `Product deletion` (`products/delete`) -> `https://<project-ref>.functions.supabase.co/shopify-products-webhook`

## 5. Required product mapping
For each Shopify product, ensure `products.shopify_product_id` is filled in Supabase.

With product webhooks enabled, this mapping is auto-maintained.

## 6. Test flow
1. Place test order in Shopify with widget properties selected.
2. Pay order (or use test payment).
3. Confirm row is created in `bookings`.
4. Open product page widget for same product/date/slot and confirm slot is unavailable.

## Notes
- The function verifies Shopify HMAC signature.
- It only inserts lines that include both a valid date and slot in line item properties.
- If a line item is missing booking properties, it is skipped intentionally.
- Admin panel now updates from realtime DB changes, so new webhook data appears without manual sync clicks.
