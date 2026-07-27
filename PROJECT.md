# 🌸 Lily Service — Project Documentation

A booking system for Kuwait-based delivery services that integrates with Shopify, enforces daily capacity limits, and provides an admin dashboard.

## Table of Contents
1. [What the project does](#1-what-the-project-does)
2. [System architecture](#2-system-architecture)
3. [User-facing surfaces](#3-user-facing-surfaces)
4. [Data model (Supabase)](#4-data-model-supabase)
5. [Server (Render)](#5-server-render)
6. [Supabase Edge Functions](#6-supabase-edge-functions)
7. [Database rules & triggers](#7-database-rules--triggers)
8. [Shopify integration — sync vs webhook](#8-shopify-integration--sync-vs-webhook)
9. [Webhook setup (Option 2 — Render pass-through)](#9-webhook-setup-option-2--render-pass-through)
10. [Environment variables](#10-environment-variables)
11. [Deploying Edge Functions](#11-deploying-edge-functions)
12. [Daily capacity logic (3 morning / 3 evening)](#12-daily-capacity-logic-3-morning--3-evening)
13. [Files in this repo](#13-files-in-this-repo)
14. [Common operations & troubleshooting](#14-common-operations--troubleshooting)

---

## 1. What the project does

Customers buy a delivery slot (morning or evening) on a Shopify product page. Each slot is **capped at 3 bookings per day** across all products. The admin sees everything in a single dashboard.

**Three hard rules enforced at the database:**
- Bookings must be ≥24 hours in the future
- No more than 3 bookings per (date, slot) across all products
- Linked product pairs (e.g. Dafwa ↔ Naseem) block each other on the same slot

---

## 2. System architecture

```
┌──────────────────────┐         ┌──────────────────────┐
│   Customer browser   │         │    Admin browser     │
│  (Shopify product    │         │  (admin-panel.html   │
│   page + widget)     │         │   hosted locally)    │
└──────────┬───────────┘         └──────────┬───────────┘
           │                                │
           │ Supabase anon key              │ /api/auth/login
           │ (read-only)                     │ (admin password)
           ▼                                ▼
   ┌─────────────────────────────────────────────────┐
   │            Supabase (Postgres + RLS)            │
   │  products · bookings · blocked_slots · zones    │
   └────────────┬────────────────────────┬───────────┘
                │                        │
                │                        ▲
   ┌────────────▼───────────┐  ┌─────────┴────────────┐
   │  Edge Functions (Deno) │  │   Webhook delivery    │
   │  · shopify-products-sync    │  (Shopify → Render   │
   │  · shopify-products-webhook  │   → Supabase func)  │
   │  · shopify-orders-sync      │                     │
   │  · shopify-order-webhook    │                     │
   └────────────┬───────────┘  └─────────┬─────────────┘
                │                        ▲
                │ triggers               │
                ▼                        │
   ┌─────────────────────────────────────────────────┐
   │   Render (Node/Express) — server.js              │
   │   · /api/auth/login + JWT                       │
   │   · /api/admin/db (passthrough)                 │
   │   · /api/shopify/sync-products / sync-orders    │
   │   · /api/shopify/webhook/{products|orders}-*    │
   └─────────────────────────────────────────────────┘
                │
                │ REST Admin API
                ▼
       ┌─────────────────┐
       │   Shopify API   │
       └─────────────────┘
```

---

## 3. User-facing surfaces

### 3.1 Booking widget (`booking-widget-v2.html`)
Embedded inside `<form action="/cart/add">` on each Shopify product page. Three-step flow:
1. **Pick date** — calendar, grayed out where slots are full / blocked / inside the 24h window
2. **Pick slot** — Morning (6:30–8:30 AM) or Evening (2:30–6:30 PM); shows live `2/3 booked` count
3. **Pick delivery area** — governorate → area; delivery fee shown

The widget writes the date/slot as **Shopify line-item properties** (`📅 Date`, `⏰ Slot`) so the order webhook can read them back. Area selection is performed at Shopify checkout.

### 3.2 Admin panel (`admin-panel.html`)
Single-file SPA, login-protected. Five pages:
- **Dashboard** — stats (today's bookings, week, blocks, today's capacity) + next-7-days table
- **All Bookings** — filterable booking list with delete
- **Order Data** — Shopify orders with booking-linked line items
- **Block Dates** — manual slot blocking
- **Products** — list with image/handle/link/active status; rename / set-link / deactivate

---

## 4. Data model (Supabase)

### `products`
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | DB key — derived from Shopify handle (`safeDbKey()`) |
| `name` | TEXT | Display name |
| `shopify_product_id` | TEXT | **Unique** — used by all upserts |
| `shopify_handle` | TEXT | For debugging / display |
| `shopify_image` | TEXT | First image URL |
| `linked_product_id` | TEXT FK→products | Pair blocking (e.g. Dafwa ↔ Naseem) |
| `is_active` | BOOL | Default TRUE |

### `bookings`
| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | Auto-generated |
| `product_id` | TEXT FK→products | |
| `booking_date` | DATE | |
| `slot` | TEXT CHECK | `morning` \| `evening` |
| `customer_name`, `customer_phone`, `customer_email` | TEXT | From Shopify order |
| `delivery_governorate`, `delivery_area`, `delivery_price` | TEXT/DECIMAL | Set at checkout |
| `shopify_order_id` | TEXT | Unique with product+date+slot |
| `notes` | TEXT | |
| `is_active` | BOOL | Default TRUE; toggle on cancel |
| `created_at` | TIMESTAMPTZ | |
| UNIQUE | `(product_id, booking_date, slot)` | One booking per product per day per slot |
| UNIQUE | `(shopify_order_id, product_id, booking_date, slot)` | Idempotent webhook upserts |

### `blocked_slots`
Manual block by admin. `product_id` NULL = applies to all products. `slot = 'all'` = whole day.

### `delivery_zones`
Governorate / area / price (KD). Arabic names. 132 rows seeded by default.

---

## 5. Server (Render)

**File:** `server.js` (Express, listens on `$PORT`).

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/auth/login` | none | Admin password → JWT (2h TTL) |
| `GET /api/auth/me` | JWT | Verify session |
| `POST /api/admin/db` | JWT | Pass-through query builder for admin panel (`sb.from(...)`) |
| `POST /api/shopify/sync-products` | JWT | Manual full sync → calls `shopify-products-sync` Edge Function |
| `POST /api/shopify/sync-orders` | JWT | Manual order sync → calls `shopify-orders-sync` |
| `POST /api/shopify/webhook/products-{create,update,delete}` | HMAC | Forwards to `shopify-products-webhook` |
| `POST /api/shopify/webhook/orders-{create,paid,cancelled}` | HMAC | Forwards to `shopify-order-webhook` |
| `GET /api/shopify/webhook-deliveries` | JWT | (optional) Recent delivery log |

**Login protection:** in-memory map `loginSecurityState` tracks failed attempts; 5 fails in 15 min → 15-min lockout. For multi-instance deployments, replace with Redis.

**Background jobs:** `orderSyncTimer` runs `syncShopifyOrdersOnce` every `SHOPIFY_ORDER_SYNC_INTERVAL_MS` (default 15s) as a safety net.

---

## 6. Supabase Edge Functions

All functions live under `supabase/functions/<name>/index.ts` for CLI deployment, with mirror `.md` files in the project root for easy reference / copy-paste.

### 6.1 `shopify-products-sync` (`product-sync.md`)
**Trigger:** admin panel → "Save Domain & Enable Auto Sync"
**Behaviour:** paginates ALL products (follows `Link: rel="next"`), upserts each with `onConflict: "shopify_product_id"`, dedupes, batches 100 at a time, falls back to per-row on batch failure. Returns `{ synced, skipped, issues[] }`.

### 6.2 `shopify-products-webhook` (`shopify-products-webhook.md`)
**Trigger:** Shopify → Render → Supabase
**Behaviours:**
- `products/create` & `products/update` → upsert single row
- `products/delete` → soft-delete (`is_active = false`)
- HMAC-verified with `SHOPIFY_PRODUCTS_WEBHOOK_SECRET`

### 6.3 `shopify-orders-sync` (existing)
**Trigger:** admin panel "Order Connection" button + background interval
**Behaviour:** pulls paid orders from Shopify Admin API and inserts bookings.

### 6.4 `shopify-order-webhook` (`shopify-order-webhook.md`)
**Trigger:** Shopify → Render → Supabase
**Behaviours:**
- `orders/paid` (and `orders/create` when `financial_status === "paid"`) → for each line item, parse `📅 Date` and `⏰ Slot` properties, insert one booking row per quantity unit; respects the 3/day capacity trigger
- `orders/create` unpaid → no-op (wait for `orders/paid`)
- `orders/cancelled` → soft-delete bookings (`is_active = false`) — DB trigger ignores capacity check when only `is_active` changes
- HMAC-verified with `SHOPIFY_ORDER_WEBHOOK_SECRET` (falls back to the products secret too)

---

## 7. Database rules & triggers

### `enforce_booking_integrity` — `BEFORE INSERT OR UPDATE`
Refuses any row that:
- Has a `booking_date < CURRENT_DATE`
- Has a slot start < NOW() + 24 hours (Asia/Kuwait timezone)
- Duplicates `(product_id, booking_date, slot)` of an existing booking
- Duplicates a `linked_product_id`'s `(booking_date, slot)`
- Would push the (date, slot) count to ≥3

**Bypass:** if the UPDATE changes ONLY `is_active` (and nothing else), the trigger short-circuits and returns NEW. This is what allows the order-cancel webhook to soft-delete without re-checking capacity or 24h rules.

### Indexes
- `uq_products_shopify_product_id` — UNIQUE constraint on `products.shopify_product_id` (full, not partial — required for `ON CONFLICT`)
- `uq_bookings_shopify_order_slot` — UNIQUE `(shopify_order_id, product_id, booking_date, slot)`
- `idx_bookings_product_date` — lookup helper

### Row-level security
- Public (`anon` role) can SELECT all tables — needed for widget availability checks
- Admin panel uses the service-role key, which bypasses RLS

---

## 8. Shopify integration — sync vs webhook

| Need | Sync function | Webhook function |
|---|---|---|
| Initial population | ✅ sync | ❌ |
| Periodic full refresh | ✅ sync | ❌ |
| A new product is created in Shopify | ❌ (only on next manual sync) | ✅ webhook (real-time) |
| Product name/image/handle changes | ❌ | ✅ webhook |
| Product is deleted | ❌ | ✅ webhook (soft delete) |
| Order is paid | ❌ (next polling tick) | ✅ webhook (real-time) |
| Order is cancelled | ❌ | ✅ webhook |

**Both paths write to the same table using `onConflict: "shopify_product_id"` — they don't fight each other.**

---

## 9. Webhook setup (Option 2 — Render pass-through)

### One-time CLI deployment
```powershell
cd C:\lily-service-project
$env:SUPABASE_ACCESS_TOKEN = "sbpt_xxxxx"        # from supabase.com/dashboard/account/tokens
npx supabase login --token $env:SUPABASE_ACCESS_TOKEN
npx supabase link --project-ref adcjzrstjrdxzfobcfbl

# Webhook functions need --no-verify-jwt (they're called by Render without a Bearer token)
npx supabase functions deploy shopify-products-webhook --no-verify-jwt --project-ref adcjzrstjrdxzfobcfbl
npx supabase functions deploy shopify-order-webhook    --no-verify-jwt --project-ref adcjzrstjrdxzfobcfbl
```

### Shopify webhooks (Settings → Notifications → Webhooks)
| Topic | URL |
|---|---|
| `products/create` | `https://lily-service-project-jk88.onrender.com/api/shopify/webhook/products-create` |
| `products/update` | `https://lily-service-project-jk88.onrender.com/api/shopify/webhook/products-update` |
| `products/delete` | `https://lily-service-project-jk88.onrender.com/api/shopify/webhook/products-delete` |
| `orders/create`    | `https://lily-service-project-jk88.onrender.com/api/shopify/webhook/orders-create` |
| `orders/paid`      | `https://lily-service-project-jk88.onrender.com/api/shopify/webhook/orders-paid` |
| `orders/cancelled` | `https://lily-service-project-jk88.onrender.com/api/shopify/webhook/orders-cancelled` |

All format = JSON.

### Verification flow
1. Send test notification from Shopify admin → check status code
2. Render logs → `[webhook ...] forwarded → 200`
3. Supabase function logs → upsert / processed / cancelled
4. `products` or `bookings` table → new row

---

## 10. Environment variables

### Render
| Variable | Used by | Example |
|---|---|---|
| `PORT` | server.js | `10000` |
| `SUPABASE_URL` | server.js | `https://adcjzrstjrdxzfobcfbl.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | server.js | `eyJhbGc…` |
| `ADMIN_PASSWORD` | server.js | (your secret) |
| `JWT_SECRET` | server.js | random 32+ char string |
| `LOGIN_WINDOW_MS`, `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCKOUT_MS` | server.js | optional tuning |
| `SHOPIFY_ADMIN_API_TOKEN` | server.js | `shpat_…` |
| `SHOPIFY_ORDER_SYNC_INTERVAL_MS` | server.js | `90000` (default 15s) |
| `SHOPIFY_WEBHOOK_SECRET` | server.js | same secret from Shopify |
| `SHOPIFY_PRODUCTS_WEBHOOK_URL` | server.js | optional override |
| `SHOPIFY_ORDER_WEBHOOK_URL` | server.js | optional override |

### Supabase Edge Functions
| Variable | Used by | Notes |
|---|---|---|
| `SUPABASE_URL` | all functions | auto-provided |
| `SUPABASE_SERVICE_ROLE_KEY` | all functions | auto-provided |
| `SHOPIFY_WEBHOOK_SECRET` | both webhook functions | must match Render + Shopify |
| `SHOPIFY_PRODUCTS_WEBHOOK_SECRET` | product webhook | optional — overrides the above for products only |
| `SHOPIFY_ORDER_WEBHOOK_SECRET` | order webhook | optional — overrides the above for orders only |

---

## 11. Deploying Edge Functions

The CLI expects `supabase/functions/<name>/index.ts`. Files in the project root with `.md` extension are reference copies — keep them in sync.

```powershell
# Initial login (one-time)
npx supabase login

# Per project (one-time)
npx supabase link --project-ref <ref>

# Deploy
npx supabase functions deploy <name> [--no-verify-jwt]
```

**`--no-verify-jwt`** is required for webhook-receiving functions because Render doesn't send a Bearer token — only HMAC.

---

## 12. Daily capacity logic (3 morning / 3 evening)

### Enforced in three places

1. **DB trigger** (`supabase-schema.sql:enforce_booking_integrity`) — the source of truth. Counts existing bookings for `(booking_date, slot)` and rejects inserts that would push the count to ≥3.

2. **Widget** (`booking-widget-v2.html`)
   - `MAX_BOOKINGS_PER_SLOT = 3` (line 257)
   - `loadFullBookedDates()` greys out dates where both slots are full
   - `checkAvail()` disables individual slots when `counts[slot] >= 3`
   - Slot button shows live `2/3 booked` counter
   - On submit, re-checks capacity and shows friendly error if full

3. **Admin panel** (`admin-panel.html`)
   - Dashboard "Today's Capacity" card shows `M/3 · E/3` with color-coded status
   - Today's Bookings subtitle explicitly says `max 3 morning + 3 evening`

### Edge cases handled
- **Linked products** (Dafwa/Naseem) — DB trigger cross-checks the linked product's bookings
- **Manual blocks** — `blocked_slots` table integrates into `checkAvail()` and the calendar greys out affected dates
- **24-hour rule** — DB trigger and widget both check `slot_start < NOW() + 24h`
- **Webhook idempotency** — UNIQUE `(shopify_order_id, product_id, booking_date, slot)` prevents double-inserts from re-delivered webhooks

---

## 13. Files in this repo

| File | Purpose |
|---|---|
| `admin-panel.html` | Single-file admin SPA |
| `booking-widget-v2.html` | Shopify product-page widget |
| `server.js` | Render Express server |
| `supabase-schema.sql` | Postgres schema (tables, indexes, triggers, RLS, seed zones) |
| `supabase/functions/shopify-products-sync/index.ts` | Manual full product sync |
| `supabase/functions/shopify-products-webhook/index.ts` | Real-time single-product upsert |
| `supabase/functions/shopify-order-webhook/index.ts` | Real-time single-order booking insert |
| `product-sync.md` | Reference copy of `shopify-products-sync` |
| `shopify-products-webhook.md` | Reference copy of `shopify-products-webhook` |
| `shopify-order-webhook.md` | Reference copy of `shopify-order-webhook` |
| `PROJECT.md` | This document |

---

## 14. Common operations & troubleshooting

### "A new product isn't showing up"
1. Check the webhook delivery log in Shopify — was the POST 200?
2. Render logs → `[webhook products-create] forwarded → 200`?
3. Supabase function logs → `[products-webhook] upserted`?
4. Manual fallback: admin panel → Products → "Save Domain & Enable Auto Sync"

### "Order was paid but no booking appeared"
1. Same check pattern, look for `[order-webhook]`
2. If you see `rejected: "This slot has reached the daily capacity of 3 bookings"` — capacity full, expected
3. If you see `skipped-unpaid` — the `orders/create` webhook arrived before the order was paid; wait for `orders/paid` (which fires automatically when the order is captured)

### "Webhook returns 401"
- HMAC mismatch. Verify the secret in Shopify admin matches Render's `SHOPIFY_WEBHOOK_SECRET` and Supabase's `SHOPIFY_*_WEBHOOK_SECRET` exactly.

### "Webhook returns 500: no unique constraint matching ON CONFLICT"
- The `products.shopify_product_id` constraint must be a full UNIQUE (not a partial index). Run:
  ```sql
  ALTER TABLE products ADD CONSTRAINT uq_products_shopify_product_id UNIQUE (shopify_product_id);
  ```

### "Schema re-paste fails with 42710"
- All `CREATE` statements are now idempotent (drop-then-add for the foreign key, drop-then-add for the constraint, drop-then-add for policies). Re-paste should work.

### "Cancel webhook silently fails"
- The trigger skips integrity checks only when `is_active` is the sole changing column. If something else was modified between insert and cancel, the trigger may reject. Check Supabase function logs.

### "I changed the schema — does the trigger still work?"
- After schema changes, re-deploy the trigger function:
  ```sql
  CREATE OR REPLACE FUNCTION enforce_booking_integrity() RETURNS TRIGGER …;
  ```
  Or just re-paste the whole `supabase-schema.sql` file (it's idempotent).