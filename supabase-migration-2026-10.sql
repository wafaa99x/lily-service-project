-- ================================================================
-- LILY SERVICE — BUG-FIX MIGRATION (2026-10)
-- ================================================================
-- Run in Supabase → SQL Editor on the EXISTING database.
--
-- PART A is additive and safe to run any time (the live widget keeps
-- working). Run PART A, then publish the updated theme files
-- (booking-system snippet + cart-v.js), THEN run PART B.
-- Running PART B before the theme update would hide bookings from
-- the old widget and make every slot look free.
-- ================================================================


-- ================================================================
-- PART A — run first
-- ================================================================

-- A1. Cancelled bookings must free their slot.
-- The old table-level UNIQUE(product_id, booking_date, slot) also counted
-- cancelled (is_active = false) rows, so a cancelled slot could never be
-- re-booked even though the widget showed it as free.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.bookings'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (product_id, booking_date, slot)'
  LOOP
    EXECUTE format('ALTER TABLE public.bookings DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_active_slot
  ON public.bookings (product_id, booking_date, slot)
  WHERE is_active;

-- A2. Product IDs come from the Shopify handle. If a handle is renamed, the
-- product sync updates products.id, which used to fail because bookings and
-- linked products referenced the old id. Cascade the rename instead.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.bookings'::regclass
      AND contype = 'f'
      AND confrelid = 'public.products'::regclass
  LOOP
    EXECUTE format('ALTER TABLE public.bookings DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES public.products(id) ON UPDATE CASCADE;

ALTER TABLE public.products DROP CONSTRAINT IF EXISTS fk_linked_product;
ALTER TABLE public.products
  ADD CONSTRAINT fk_linked_product
  FOREIGN KEY (linked_product_id) REFERENCES public.products(id)
  ON UPDATE CASCADE ON DELETE SET NULL;

-- A3. Integrity trigger fixes (same rules as before):
--  * Inactive rows never take capacity, so cancelling needs no checks.
--  * Re-activating a cancelled booking IS checked again (previously it
--    slipped through and could over-book a slot).
--  * Editing an active booking without moving it (notes, customer details,
--    delivery fields) no longer fails the 24-hour rule.
CREATE OR REPLACE FUNCTION public.enforce_booking_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  slot_start timestamptz;
  linked_id text;
  booking_count integer;
BEGIN
  IF NEW.is_active IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.is_active IS TRUE
     AND NEW.product_id   = OLD.product_id
     AND NEW.booking_date = OLD.booking_date
     AND NEW.slot         = OLD.slot
  THEN
    RETURN NEW;
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

  SELECT linked_product_id INTO linked_id
  FROM public.products
  WHERE id = NEW.product_id;

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

DROP TRIGGER IF EXISTS trg_enforce_booking_integrity ON public.bookings;
CREATE TRIGGER trg_enforce_booking_integrity
BEFORE INSERT OR UPDATE ON public.bookings
FOR EACH ROW
EXECUTE FUNCTION public.enforce_booking_integrity();

-- A4. Public availability view — only what the widget and cart need.
-- No customer names, phones, emails or order numbers.
CREATE OR REPLACE VIEW public.booking_slots AS
  SELECT product_id, booking_date, slot, is_active
  FROM public.bookings
  WHERE is_active = TRUE;

GRANT SELECT ON public.booking_slots TO anon, authenticated;

-- A5. Realtime "something changed" signal without exposing booking rows.
-- The widget and cart subscribe to this one-row table and re-check
-- availability when it changes.
CREATE TABLE IF NOT EXISTS public.availability_ping (
  id         integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  changed_at timestamptz NOT NULL DEFAULT NOW()
);
INSERT INTO public.availability_ping (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.availability_ping ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read availability_ping" ON public.availability_ping;
CREATE POLICY "Public read availability_ping"
  ON public.availability_ping FOR SELECT USING (TRUE);

CREATE OR REPLACE FUNCTION public.bump_availability_ping()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.availability_ping SET changed_at = NOW() WHERE id = 1;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_ping_bookings ON public.bookings;
CREATE TRIGGER trg_ping_bookings
AFTER INSERT OR UPDATE OR DELETE ON public.bookings
FOR EACH STATEMENT EXECUTE FUNCTION public.bump_availability_ping();

DROP TRIGGER IF EXISTS trg_ping_blocked_slots ON public.blocked_slots;
CREATE TRIGGER trg_ping_blocked_slots
AFTER INSERT OR UPDATE OR DELETE ON public.blocked_slots
FOR EACH STATEMENT EXECUTE FUNCTION public.bump_availability_ping();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'availability_ping'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.availability_ping;
  END IF;
END $$;

-- A6. Link the real Dafwa ↔ Naseem rows (synced from Shopify).
-- The product sync never sets linked_product_id, so the linked-product rule
-- was not enforced for the synced rows.
UPDATE public.products a
SET linked_product_id = b.id
FROM public.products b
WHERE a.shopify_product_id = '8811194319045'   -- ستاند دفوه
  AND b.shopify_product_id = '8811194548421';  -- ستاند نسيم

UPDATE public.products a
SET linked_product_id = b.id
FROM public.products b
WHERE a.shopify_product_id = '8811194548421'
  AND b.shopify_product_id = '8811194319045';

-- A7. Hide the original placeholder rows (no Shopify product behind them).
UPDATE public.products
SET is_active = FALSE
WHERE shopify_product_id IS NULL
  AND id IN ('dafwa', 'naseem', 'product-3', 'product-4', 'product-5', 'product-6');

-- A8. Faster duplicate checks for rejections written by the order webhook.
CREATE INDEX IF NOT EXISTS idx_booking_rejections_lookup
  ON public.booking_rejections (shopify_order_id, product_id, booking_date, slot);


-- ================================================================
-- PART B — run AFTER the new theme files are live
-- ================================================================
-- Stops anyone with the public (anon) key from reading customer names,
-- phones, emails and order numbers. The admin panel is unaffected: it
-- reads through server.js with the service-role key.

DROP POLICY IF EXISTS "Public read bookings" ON public.bookings;
DROP POLICY IF EXISTS "Public read booking_rejections" ON public.booking_rejections;

-- Realtime no longer needs to broadcast these tables.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication_tables
             WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'bookings') THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.bookings;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_publication_tables
             WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'booking_rejections') THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.booking_rejections;
  END IF;
END $$;
