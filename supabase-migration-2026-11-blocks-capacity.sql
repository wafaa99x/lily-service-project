-- ================================================================
-- LILY SERVICE — MANUAL BLOCKS COUNT TOWARD CAPACITY (2026-11)
-- Supabase → SQL Editor → paste all → Run. Safe while the shop is live.
-- Run AFTER the 2026-10 migration (PART A, A2, A3, B).
-- ================================================================
--
-- New rules for a manual block on ONE package (blocked_slots.product_id set):
--   1. It takes one of the 2 places in that slot, like an offline booking.
--      Block 1 package  -> every other package shows 1/2.
--      Block 2 packages -> the slot is full for everyone.
--   2. A block on Naseem also closes Dafwa (and the other way round),
--      exactly like a real booking does.
--   3. No double counting: a package that has a booking AND a block, or
--      Naseem + Dafwa both blocked/booked, is still ONE place.
-- Blocks with no package (product_id NULL) close the slot for everyone,
-- unchanged.
--
-- What changes:
--   * booking_slots view  -> now also lists package blocks (one row per
--     place used). The product page and cart already read this view, so
--     they pick up the new rules with NO theme change.
--   * enforce_booking_integrity() -> the database rule: same checks as
--     before, plus rules 1-3. Paid orders that break them are rejected
--     and land in booking_rejections (refund alert), as today.
-- ================================================================


-- 1. Public view used by the product page and cart (no customer data).
--    Same 4 columns as before, so nothing that reads it breaks.
--    Each row = one place used in a slot. A Naseem/Dafwa pair counts as one.
CREATE OR REPLACE VIEW public.booking_slots AS
WITH occupancy AS (
  -- real bookings
  SELECT b.product_id, b.booking_date, b.slot, 0 AS priority
  FROM public.bookings b
  WHERE b.is_active = TRUE

  UNION ALL

  -- manual blocks on one package ('all' / NULL slot = both slots)
  SELECT bs.product_id, bs.block_date AS booking_date, s.slot, 1 AS priority
  FROM public.blocked_slots bs
  CROSS JOIN (VALUES ('morning'::text), ('evening'::text)) AS s(slot)
  WHERE bs.product_id IS NOT NULL
    AND (bs.slot IS NULL OR bs.slot = 'all' OR bs.slot = s.slot)
)
SELECT DISTINCT ON (o.booking_date, o.slot, COALESCE(LEAST(p.id, p.linked_product_id), o.product_id))
  o.product_id,
  o.booking_date,
  o.slot,
  TRUE AS is_active
FROM occupancy o
LEFT JOIN public.products p ON p.id = o.product_id
ORDER BY o.booking_date, o.slot, COALESCE(LEAST(p.id, p.linked_product_id), o.product_id), o.priority;

GRANT SELECT ON public.booking_slots TO anon, authenticated;


-- 2. Database rule for every booking (website orders AND admin panel).
CREATE OR REPLACE FUNCTION public.enforce_booking_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  slot_start timestamptz;
  linked_id text;
  bookable boolean;
  places_used integer;
BEGIN
  IF NEW.is_active IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- Editing an active booking without moving it (notes, customer, delivery fields)
  IF TG_OP = 'UPDATE'
     AND OLD.is_active IS TRUE
     AND NEW.product_id   = OLD.product_id
     AND NEW.booking_date = OLD.booking_date
     AND NEW.slot         = OLD.slot
  THEN
    RETURN NEW;
  END IF;

  SELECT linked_product_id, is_bookable INTO linked_id, bookable
  FROM public.products
  WHERE id = NEW.product_id;

  IF bookable IS FALSE THEN
    RAISE EXCEPTION 'This product is an add-on and cannot be booked for a slot';
  END IF;

  IF NEW.booking_date < (NOW() AT TIME ZONE 'Asia/Kuwait')::date THEN
    RAISE EXCEPTION 'Past-date bookings are not allowed';
  END IF;

  slot_start := ((NEW.booking_date + CASE NEW.slot
    WHEN 'morning' THEN time '06:30'
    ELSE time '14:30'
  END) AT TIME ZONE 'Asia/Kuwait');

  IF slot_start < NOW() + INTERVAL '24 hours' THEN
    RAISE EXCEPTION 'Bookings must be at least 24 hours in advance';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.booking_date::text || '|' || NEW.slot, 0));

  -- Slot blocked by the admin: whole slot, this package, or (NEW) its linked stand
  IF EXISTS (
    SELECT 1 FROM public.blocked_slots
    WHERE block_date = NEW.booking_date
      AND (slot IS NULL OR slot = 'all' OR slot = NEW.slot)
      AND (product_id IS NULL
           OR product_id = NEW.product_id
           OR (linked_id IS NOT NULL AND product_id = linked_id))
  ) THEN
    RAISE EXCEPTION 'This slot is blocked by the admin';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.bookings
    WHERE product_id = NEW.product_id
      AND booking_date = NEW.booking_date
      AND slot = NEW.slot
      AND is_active = TRUE
      AND (TG_OP = 'INSERT' OR id <> NEW.id)
  ) THEN
    RAISE EXCEPTION 'This product is already booked for that date and slot';
  END IF;

  IF linked_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.bookings
    WHERE product_id = linked_id
      AND booking_date = NEW.booking_date
      AND slot = NEW.slot
      AND is_active = TRUE
      AND (TG_OP = 'INSERT' OR id <> NEW.id)
  ) THEN
    RAISE EXCEPTION 'Linked product is already booked for that date and slot';
  END IF;

  -- Capacity: places used by other bookings AND package blocks (NEW).
  -- A Naseem/Dafwa pair is one place; a package with a booking and a block is one place.
  SELECT COUNT(DISTINCT u.place) INTO places_used
  FROM (
    SELECT COALESCE(LEAST(p.id, p.linked_product_id), b.product_id) AS place
    FROM public.bookings b
    LEFT JOIN public.products p ON p.id = b.product_id
    WHERE b.booking_date = NEW.booking_date
      AND b.slot = NEW.slot
      AND b.is_active = TRUE
      AND (TG_OP = 'INSERT' OR b.id <> NEW.id)

    UNION ALL

    SELECT COALESCE(LEAST(p.id, p.linked_product_id), bs.product_id)
    FROM public.blocked_slots bs
    LEFT JOIN public.products p ON p.id = bs.product_id
    WHERE bs.block_date = NEW.booking_date
      AND bs.product_id IS NOT NULL
      AND (bs.slot IS NULL OR bs.slot = 'all' OR bs.slot = NEW.slot)
  ) u;

  IF places_used >= 2 THEN
    RAISE EXCEPTION 'This slot has reached the daily capacity of 2 bookings';
  END IF;

  RETURN NEW;
END;
$$;

-- (The trigger trg_enforce_booking_integrity already exists and keeps using this function.)


-- ================================================================
-- CHECK 1 (run this): Naseem and Dafwa must point at EACH OTHER.
-- Expect 2 rows, each with partner_links_back = true.
-- If not, re-run step A6 of supabase-migration-2026-10.sql.
-- SELECT p.name, p.linked_product_id,
--        (l.linked_product_id = p.id) AS partner_links_back
-- FROM public.products p
-- LEFT JOIN public.products l ON l.id = p.linked_product_id
-- WHERE p.shopify_product_id IN ('8811194319045', '8811194548421');
--
-- CHECK 2 (optional): places used per slot from today on.
-- SELECT booking_date, slot, COUNT(*) AS places_used
-- FROM public.booking_slots
-- WHERE booking_date >= (NOW() AT TIME ZONE 'Asia/Kuwait')::date
-- GROUP BY booking_date, slot ORDER BY booking_date, slot;
-- ================================================================

-- ================================================================
-- UNDO (only if you need to go back to the old behaviour):
-- 1) Re-run PART A2 of supabase-migration-2026-10-part-A2.sql (old trigger function)
-- 2) Run:
-- CREATE OR REPLACE VIEW public.booking_slots AS
--   SELECT product_id, booking_date, slot, is_active
--   FROM public.bookings WHERE is_active = TRUE;
-- ================================================================
