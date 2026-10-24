-- ================================================================
-- LILY SERVICE — PART A3: "Paid orders that could not be booked"
-- Supabase → SQL Editor. Run the CHECK first, then the FIX.
-- ================================================================


-- ================================================================
-- CHECK (read-only) — which alerts are false and which are real?
-- ================================================================
-- false_alert = TRUE  → the same order DID get its booking (duplicate webhook delivery).
--                       Nothing to do for the customer.
-- false_alert = FALSE → the order really has no booking for that line.
--                       Contact the customer: rebook or refund.
SELECT
  r.order_name,
  r.product_name,
  r.booking_date,
  r.slot,
  r.reason,
  COUNT(*)                                        AS times_logged,
  BOOL_OR(b.id IS NOT NULL)                       AS false_alert
FROM public.booking_rejections r
LEFT JOIN public.bookings b
  ON  b.shopify_order_id = r.shopify_order_id
  AND b.product_id       = r.product_id
  AND b.booking_date     = r.booking_date
  AND b.slot             = r.slot
GROUP BY r.order_name, r.product_name, r.booking_date, r.slot, r.reason
ORDER BY false_alert, r.order_name DESC;


-- ================================================================
-- FIX — run after looking at the CHECK above
-- ================================================================

-- 1. Alerts can be marked resolved from the admin panel ("Mark resolved").
ALTER TABLE public.booking_rejections
  ADD COLUMN IF NOT EXISTS resolved    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- 2. Auto-resolve the false alerts: the order already has its booking.
UPDATE public.booking_rejections r
SET resolved = TRUE,
    resolved_at = NOW()
FROM public.bookings b
WHERE b.shopify_order_id = r.shopify_order_id
  AND b.product_id       = r.product_id
  AND b.booking_date     = r.booking_date
  AND b.slot             = r.slot
  AND r.resolved = FALSE;

-- 3. Remove exact duplicates (same order + product + date + slot logged twice),
--    keeping the oldest row.
DELETE FROM public.booking_rejections r
USING public.booking_rejections older
WHERE r.shopify_order_id = older.shopify_order_id
  AND r.product_id   IS NOT DISTINCT FROM older.product_id
  AND r.booking_date IS NOT DISTINCT FROM older.booking_date
  AND r.slot         IS NOT DISTINCT FROM older.slot
  AND (r.created_at, r.id) > (older.created_at, older.id);

-- 4. Never store the same alert twice again (webhook retries).
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_rejections_line
  ON public.booking_rejections (
    shopify_order_id,
    COALESCE(product_id, ''),
    COALESCE(booking_date, DATE '1970-01-01'),
    COALESCE(slot, '')
  );

-- 5. Faster "open alerts" list on the dashboard.
CREATE INDEX IF NOT EXISTS idx_booking_rejections_open
  ON public.booking_rejections (created_at DESC)
  WHERE resolved = FALSE;
