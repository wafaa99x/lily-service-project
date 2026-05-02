# Complete Setup Guide
## Shopify Booking System — Step by Step

---

## OVERVIEW: What You're Building

```
Customer visits product page
        ↓
Booking Widget loads (date picker + slots + area)
        ↓
Widget checks Supabase database → "is this slot taken?"
        ↓
Customer selects date + slot + area → clicks Add to Cart
        ↓
Booking data travels with the Shopify order as properties
        ↓
You see it in Shopify orders AND in your Admin Panel
```

---

## STEP 1 — Set Up Supabase (Your Database)

**Supabase is the free database that stores all booking data.**

### 1A. Create your account
1. Go to **https://supabase.com**
2. Click **Start your project** → sign up with GitHub or email
3. Click **New Project**
4. Name it: `booking-system` (or anything you want)
5. Set a strong database password → **save it somewhere**
6. Region: choose **Middle East** or closest to Kuwait → click **Create**
7. Wait ~2 minutes for it to finish

### 1B. Run the database schema
1. In your Supabase project, click **SQL Editor** in the left sidebar
2. Click **+ New Query**
3. Open the file **`supabase-schema.sql`** (provided separately)
4. Copy the ENTIRE contents → paste into the SQL editor
5. Click **Run** (green button)
6. You should see: `Success. No rows returned`
7. ✅ Your tables are now created

### 1C. Get your API keys
1. Click **Settings** (gear icon) → **API** in the left sidebar
2. Copy these two values — you'll need them in every file:
   - **Project URL** → looks like: `https://xjenagylukeeeutljpak.supabase.co`
   - **anon / public key** → long string starting with `eyJhbGci...`
   - **service_role key** → another long string (for admin panel ONLY — keep secret)

> ⚠️ The **anon key** is safe to put in your Shopify product pages.
> The **service_role key** is for the admin panel only — never put it in public pages.

---

## STEP 2 — Test Your Database Connection

Before touching Shopify, verify Supabase works:

1. In Supabase → click **Table Editor** in the left sidebar
2. You should see these tables listed:
   - `products`
   - `bookings`
   - `blocked_slots`
   - `delivery_zones`
3. Click **products** → you should see your 6 products listed
4. Click **delivery_zones** → you should see the sample Kuwait areas

If you see the tables ✅ — move to Step 3.
If tables are empty or missing — re-run the SQL from Step 1B.

---

## STEP 3 — Rename Your Products

The schema uses placeholder names. Update them to match your real product names.

### Option A: Via Admin Panel (easiest)
1. Open **`admin-panel.html`** in your browser
2. Log in → go to **Products** page
3. Click **Rename** next to each product and type your real name
4. The IDs stay the same — only the display names change

### Option B: Directly in Supabase
1. Supabase → Table Editor → **products**
2. Click any cell to edit inline
3. Change the `name` column values to your real product names

> **Important:** The IDs (`dafwa`, `naseem`, `product-3` etc.) must match
> exactly what you put in `BK_PRODUCT_ID` in the widget code.
> IDs are case-sensitive.

---

## STEP 4 — Set Up Delivery Zones

Add your real Kuwait delivery areas and prices.

### Via Admin Panel:
1. Open admin panel → **Delivery Zones**
2. The sample zones are already there — edit or delete them
3. To add a new zone: fill in Area Name + Price (KD) → click **Save Zone**
4. To edit: click **Edit** next to any zone
5. To hide (not delete): click **Hide** — it won't show to customers

### Pricing format:
- Enter prices in KD with 3 decimal places: `1.500`, `2.000`, `2.500`
- The widget will show the price automatically when customer selects their area

---

## STEP 5 — Add the Widget to Shopify

This is the main step. You'll do this **once per product** (6 times total).

### 5A. Open Shopify Theme Editor
1. Shopify Admin → **Online Store** → **Themes**
2. Find your active theme → click **⋯** (three dots) → **Edit Code**
3. The code editor opens

### 5B. Find the Product Template File
Look in the left file list for one of these (depends on your theme):
- `sections/main-product.liquid`  ← most common
- `sections/product-template.liquid`
- `templates/product.liquid`

Click the file to open it.

### 5C. Find the Add to Cart Form
Press **Ctrl+F** (or Cmd+F on Mac) and search for:
```
action="/cart/add"
```
You'll find a line like:
```html
<form action="/cart/add" method="post" ...>
```

### 5D. Paste the Widget Code
1. Open **`booking-widget-v2.html`** (the widget file)
2. Copy the **entire** contents
3. Back in Shopify, paste it INSIDE the form tag — place it BEFORE the
   quantity selector or "Add to Cart" button section

It should look like this after pasting:
```html
<form action="/cart/add" method="post" ...>

  <!-- ← PASTE WIDGET CODE HERE -->
  <input type="hidden" id="bk-date-val" name="properties[📅 Date]">
  ... (rest of widget) ...

  <!-- Shopify's existing quantity/button code continues below -->
  <input type="number" name="quantity" ...>
  <button type="submit">Add to Cart</button>

</form>
```

### 5E. Set the Product ID (CRITICAL)
Near the top of the pasted code, find this line:
```javascript
var BK_PRODUCT_ID = "dafwa";
```
Change it to match THIS product's database ID exactly.
- For product 1: `"dafwa"`
- For product 2: `"naseem"`
- For product 3: `"product-3"`
- etc.

### 5F. Confirm the Supabase keys are correct
Find these two lines in the pasted code:
```javascript
var BK_SUPABASE_URL = "https://xjenagylukeeeutljpak.supabase.co";
var BK_SUPABASE_KEY = "eyJhbGci...";
```
These are already filled in with your keys from the existing code.
If you see your Supabase URL there — ✅ leave them as is.

### 5G. Save and preview
1. Click **Save** in Shopify
2. Click **Preview** to see the product page
3. You should see the booking widget with the calendar and slots

### 5H. Repeat for all 6 products
For each product, the ONLY thing you change is line:
```javascript
var BK_PRODUCT_ID = "your-product-id";
```
Everything else stays identical.

---

## STEP 6 — Test a Booking End-to-End

Before going live, test the full flow:

1. Open a product page
2. Select a date (tomorrow or later)
3. Both slots should show "Available"
4. Select Morning → it turns gold/selected
5. Select a delivery area → fee appears
6. The dark summary bar appears at the bottom of the widget
7. Click **Add to Cart**
8. Go to your Shopify cart → expand the line item
9. You should see: `📅 Date | ⏰ Slot | 📍 Area | 🚚 Delivery (KD)`

Then verify in Supabase:
1. Booking data is passed in Shopify line item properties (`Date`, `Slot`, `Area`, `Delivery`)
2. After webhook setup in Step 6.5, paid orders auto-create rows in `bookings`

> **Note:** Keep the Admin Panel "Add Booking" page as a fallback for exceptions.

### 6.5 Enable Shopify Event-Driven Auto-Sync (Webhooks -> Supabase)
This removes manual lag and prevents slots from staying open after payment.

1. Deploy these Supabase Edge Functions:
        - [supabase/functions/shopify-orders-paid/index.ts](supabase/functions/shopify-orders-paid/index.ts)
        - [supabase/functions/shopify-products-webhook/index.ts](supabase/functions/shopify-products-webhook/index.ts)
2. Set Edge Function secrets:
        - `SUPABASE_URL` = your project URL
        - `SUPABASE_SERVICE_ROLE_KEY` = your service role key
        - `SHOPIFY_WEBHOOK_SECRET` = webhook signing secret from Shopify
        - `SHOPIFY_PRODUCTS_WEBHOOK_SECRET` = signing secret for product webhooks (or reuse order secret)
3. If you deploy the admin app on Render, set these Web Service env vars:
        - `SHOPIFY_STORE_DOMAIN` = your store domain, e.g. `snapstoress.myshopify.com`
        - `SHOPIFY_ADMIN_API_TOKEN` = Shopify Admin API token, stored only on the server
        - `SUPABASE_URL` = your Supabase project URL
        - `SUPABASE_SERVICE_ROLE_KEY` = your Supabase service role key
4. In Shopify Admin: **Settings -> Notifications -> Webhooks -> Create webhook**
5. Create order webhook:
        - Event: `Order payment` (`orders/paid`)
        - Format: `JSON`
        - URL: `https://<project-ref>.functions.supabase.co/shopify-orders-paid`
6. Create product webhooks (same URL for all):
        - `products/create` -> `https://<project-ref>.functions.supabase.co/shopify-products-webhook`
        - `products/update` -> `https://<project-ref>.functions.supabase.co/shopify-products-webhook`
        - `products/delete` -> `https://<project-ref>.functions.supabase.co/shopify-products-webhook`
7. Save and send test webhooks from Shopify
8. Verify:
        - paid order creates/updates rows in `bookings`
        - product create/update/delete updates `products`

---

## STEP 7 — Set Up the Admin Panel

The admin panel is a standalone HTML file you open in your browser.

### 7A. Host options (choose one):

**Option A — Run Locally (simplest)**
- Just double-click `admin-panel.html` to open it in your browser
- Works perfectly for daily use
- No hosting needed

**Option B — Upload to Shopify as a Page (recommended)**
1. Shopify Admin → **Online Store** → **Pages** → **Add page**
2. Click the `<>` source button in the editor
3. Paste the entire contents of `admin-panel.html`
4. Set the page to **Hidden** (not in navigation)
5. Save — access it from a private URL only you know

**Option C — Any free host (Netlify, etc.)**
- Drag and drop the HTML file to netlify.com/drop
- Get a private URL

### 7B. Log in
1. Open the admin panel
2. Enter: Password = `admin2024` (change this in the file — search for `ADMIN_PASSWORD`)
3. Enter your Supabase URL and **Service Role Key** (not anon key!)
4. Click Sign In
5. Open **Shopify Connection** from Orders or Products page and save your Shopify domain once.
6. Admin panel now auto-updates via realtime DB changes (no manual sync button required).

### 7C. What you can do in the admin panel:
- **Dashboard** — see today's and upcoming bookings at a glance
- **All Bookings** — full list, filter by date or product, delete if needed
- **Add Booking** — manual fallback if a webhook payload is missing date/slot
- **Block Dates** — block specific dates or slots for any/all products
- **Delivery Zones** — add, edit, remove Kuwait areas and prices
- **Products** — rename products, see linked pairs

---

## STEP 8 — Your Daily Workflow

### When a customer places an order:
1. You receive the Shopify order notification
2. The order shows the booking details in the line item properties
3. Shopify sends `orders/paid` webhook to Supabase
4. Supabase auto-inserts booking row(s) into `bookings`
5. ✅ Slot is blocked on the widget immediately for future customers
6. Use Admin Panel → **Add Booking** only as fallback

### When you need to block a day off (holiday, maintenance, etc.):
1. Admin Panel → **Block Dates**
2. Select the date
3. Choose: Entire Day / Morning Only / Evening Only
4. Choose: All Products / Specific Product
5. Click **Block This Date/Slot**
6. ✅ Customers will see those slots as "Unavailable" immediately

### When you want to add/change a delivery area or price:
1. Admin Panel → **Delivery Zones**
2. Edit the price or add a new area
3. ✅ Widget updates in real-time for all customers

---

## STEP 9 — The Linked Products (Dafwa ↔ Naseem)

This is already handled automatically. Here's how it works:

- Dafwa and Naseem are configured as a linked pair in the widget:
  ```javascript
        var BK_LINKED_PAIRS = [["dafwa", "naseem"]];
  ```
- When a booking is saved for `dafwa` on March 15 Morning...
- A customer viewing Naseem on March 15 will see Morning as **Unavailable**
- And vice versa — they block each other automatically
- No extra setup needed

---

## TROUBLESHOOTING

### Widget doesn't appear on product page
- Check that you pasted inside the `<form action="/cart/add">` tag
- Make sure Supabase JS is loading (check browser console for errors)
- Try a hard refresh: Ctrl+Shift+R

### Slots always show "Unavailable"
- Check your Supabase URL and anon key are correct
- Go to Supabase → Authentication → Policies and confirm the read policies exist
- Check browser console (F12) for error messages

### Delivery areas not loading
- Confirm you ran the full SQL schema
- Check that `delivery_zones` table has rows in Supabase Table Editor
- Confirm `is_active = true` for your zones

### Admin panel won't log in
- Double-check the password matches `ADMIN_PASSWORD` in the file
- Make sure you're using the **Service Role key** (not the anon key) for the admin panel

### "Slot already booked" but I didn't book it
- Check the `blocked_slots` table in Supabase for that date
- Check the `bookings` table for that product + date combination

---

## FILE SUMMARY

| File | Purpose | Where it goes |
|------|---------|---------------|
| `supabase-schema.sql` | Creates database tables | Paste into Supabase SQL Editor (once) |
| `booking-widget-v2.html` | Customer-facing booking UI | Inside Shopify product page template |
| `admin-panel.html` | Your management dashboard | Open locally or host privately |

---

## SECURITY NOTES

- The **anon key** in the widget is safe to expose — it only allows reading availability and zones
- The **service_role key** is only in your admin panel — never put it in Shopify product pages
- The admin panel password is stored in the HTML file — change `admin2024` to something strong
- Supabase Row Level Security is enabled — public users can only READ, not write

---

*Setup complete. You now have a fully functional booking system with no monthly fees.*
