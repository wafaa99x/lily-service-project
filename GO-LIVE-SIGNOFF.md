# Booking System Go-Live Signoff Sheet

Project: Shopify Booking + Supabase

Store Domain: snapstoress.myshopify.com

Supabase Project Ref: xjenagylukeeeutljpak

Target Go-Live Date: ____________________

Prepared By: ____________________

Reviewed By: ____________________

## 1) Requirement: Widget column mapping fixed

- [ ] PASS
- [ ] FAIL

Checks:
- [ ] Widget uses `product_id` (not `product`)
- [ ] Widget uses `booking_date` (not `date`)
- [ ] Block query uses `block_date` (not `date`)

Evidence (links/screenshots/query output):

Notes:

## 2) Requirement: Shopify paid order auto-writes to bookings

- [ ] PASS
- [ ] FAIL

Checks:
- [ ] Edge Function `shopify-orders-paid` is deployed
- [ ] Secret `SHOPIFY_WEBHOOK_SECRET` is set
- [ ] Secret `SUPABASE_SERVICE_ROLE_KEY` is set
- [ ] Shopify webhook topic is `orders/paid`
- [ ] Shopify webhook URL points to orders function endpoint
- [ ] Paid test order creates row in `bookings`

Evidence (order id, DB row, function logs):

Notes:

## 3) Requirement: Products fetched directly from Shopify and shown in admin

- [ ] PASS
- [ ] FAIL

Checks:
- [ ] Edge Function `shopify-products-sync` is deployed
- [ ] Admin Products sync action returns success
- [ ] Products table updated with Shopify mapping fields
- [ ] Products visible in admin panel after sync

Evidence (sync response, admin screenshot, DB query):

Notes:

## 4) Requirement: Kuwait delivery zones configured

- [ ] PASS
- [ ] FAIL

Checks:
- [ ] `delivery_zones` table has final Kuwait zone list
- [ ] Prices are correct in KD
- [ ] Zones visible in admin panel
- [ ] Zones visible in widget dropdown

Evidence (zone list, screenshot, price check):

Notes:

## 5) Requirement: Widget installed on each Shopify product page

- [ ] PASS
- [ ] FAIL

Checks:
- [ ] Widget inserted inside each product add-to-cart form
- [ ] `BK_PRODUCT_ID` is correct per product
- [ ] Linked products block logic validated
- [ ] Add-to-cart blocked unless date + slot + area selected

Evidence (theme files, product URLs tested, screenshots):

Notes:

## Test Run Summary

Test Window Start: ____________________

Test Window End: ____________________

Critical Defects Found: ____________________

Critical Defects Resolved: ____________________

Open Risks (must be accepted if any):

## Security Confirmation

- [ ] Shopify admin token rotated after setup
- [ ] Supabase personal access token rotated after deployment
- [ ] Service role key treated as secret and not exposed in storefront
- [ ] Admin panel access is restricted

## Final Go-Live Decision

- [ ] APPROVED FOR GO-LIVE
- [ ] NOT APPROVED

Decision Date: ____________________

Approver Name: ____________________

Approver Signature: ____________________

Rollback Owner: ____________________

Rollback Plan Location: ____________________
