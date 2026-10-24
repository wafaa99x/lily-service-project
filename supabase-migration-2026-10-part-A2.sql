-- ================================================================
-- LILY SERVICE — PART A2 (run right AFTER PART A, before PART B)
-- Supabase → SQL Editor → paste all → Run. Safe while the shop is live.
-- ================================================================

-- A2.1  Which products are real bookings.
-- Add-ons and delivery fees (Shopify tag "non-package") are NOT bookings.
-- The product sync / products webhook keep this column up to date from the tags.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS is_bookable BOOLEAN NOT NULL DEFAULT TRUE;

-- The 4 delivery fee products are known already; the add-ons get their value
-- the next time you press "Sync products" in the admin panel (step 5 of the guide).
UPDATE public.products
SET is_bookable = FALSE
WHERE shopify_handle LIKE 'delivery-fee-%';


-- A2.2  Booking trigger: same rules as PART A, plus
--   * a slot blocked by the admin can't be booked (it was only checked in the browser)
--   * products that are not bookable (add-ons) can't take a slot
CREATE OR REPLACE FUNCTION public.enforce_booking_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  slot_start timestamptz;
  linked_id text;
  bookable boolean;
  booking_count integer;
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

  -- NEW: slot blocked by the admin (whole day, this slot, all products or this product)
  IF EXISTS (
    SELECT 1 FROM public.blocked_slots
    WHERE block_date = NEW.booking_date
      AND (slot IS NULL OR slot = 'all' OR slot = NEW.slot)
      AND (product_id IS NULL OR product_id = NEW.product_id)
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

  SELECT COUNT(*) INTO booking_count
  FROM public.bookings
  WHERE booking_date = NEW.booking_date
    AND slot = NEW.slot
    AND is_active = TRUE
    AND (TG_OP = 'INSERT' OR id <> NEW.id);

  IF booking_count >= 2 THEN
    RAISE EXCEPTION 'This slot has reached the daily capacity of 2 bookings';
  END IF;

  RETURN NEW;
END;
$$;

-- (The trigger itself was created in PART A and keeps using this function.)


-- A2.3  Check: should list only the 4 delivery fee products now,
-- and also the add-ons after you run "Sync products".
-- SELECT id, name, is_bookable FROM public.products WHERE is_bookable = FALSE ORDER BY name;
