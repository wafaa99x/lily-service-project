-- ================================================================
-- SHOPIFY BOOKING SYSTEM — SUPABASE DATABASE SCHEMA
-- ================================================================
-- HOW TO USE:
-- 1. Go to your Supabase project → SQL Editor
-- 2. Paste this entire file and click "Run"
-- 3. Done! Your database is ready.
-- ================================================================


-- ----------------------------------------------------------------
-- TABLE 1: PRODUCTS
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  shopify_product_id TEXT,
  shopify_handle    TEXT,
  shopify_image     TEXT,
  linked_product_id TEXT,         -- for Dafwa ↔ Naseem blocking
  is_active         BOOLEAN DEFAULT TRUE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE products ADD COLUMN IF NOT EXISTS shopify_product_id TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS shopify_handle TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS shopify_image TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_products_shopify_product_id
  ON products (shopify_product_id)
  WHERE shopify_product_id IS NOT NULL;

-- Self-reference foreign key for linked products
ALTER TABLE products
  ADD CONSTRAINT fk_linked_product
  FOREIGN KEY (linked_product_id) REFERENCES products(id);

-- ✏️  RENAME the product IDs/names to match your Shopify products
INSERT INTO products (id, name, linked_product_id) VALUES
  ('dafwa',     'Dafwa',     'naseem'),   -- linked pair
  ('naseem',    'Naseem',    'dafwa'),    -- linked pair
  ('product-3', 'Product 3', NULL),       -- rename these
  ('product-4', 'Product 4', NULL),
  ('product-5', 'Product 5', NULL),
  ('product-6', 'Product 6', NULL)
ON CONFLICT (id) DO NOTHING;


-- ----------------------------------------------------------------
-- TABLE 2: BOOKINGS
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bookings (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id       TEXT NOT NULL REFERENCES products(id),
  booking_date     DATE NOT NULL,
  slot             TEXT NOT NULL CHECK (slot IN ('morning', 'evening')),
  customer_name    TEXT,
  customer_phone   TEXT,
  customer_email   TEXT,
  delivery_area    TEXT,
  delivery_price   DECIMAL(10, 3),
  shopify_order_id TEXT,
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),

  -- Prevents double-booking: one booking per product per day per slot
  UNIQUE(product_id, booking_date, slot)
);

-- Database integrity guardrails:
-- - no past-day bookings
-- - no bookings inside the 24-hour prep window
-- - no double booking for the same product/date/slot
-- - linked products (Dafwa/Naseem) block each other for the same date/slot
CREATE OR REPLACE FUNCTION enforce_booking_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  slot_start timestamptz;
  linked_id text;
BEGIN
  IF NEW.booking_date < CURRENT_DATE THEN
    RAISE EXCEPTION 'Past-date bookings are not allowed';
  END IF;

  slot_start := ((NEW.booking_date + CASE NEW.slot
    WHEN 'morning' THEN time '06:30'
    ELSE time '14:30'
  END) AT TIME ZONE 'Asia/Kuwait');

  IF slot_start < NOW() + INTERVAL '24 hours' THEN
    RAISE EXCEPTION 'Bookings must be at least 24 hours in advance';
  END IF;

  IF EXISTS (
    SELECT 1 FROM bookings
    WHERE product_id = NEW.product_id
      AND booking_date = NEW.booking_date
      AND slot = NEW.slot
      AND (TG_OP = 'INSERT' OR id <> NEW.id)
  ) THEN
    RAISE EXCEPTION 'This product is already booked for that date and slot';
  END IF;

  SELECT linked_product_id INTO linked_id
  FROM products
  WHERE id = NEW.product_id;

  IF linked_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM bookings
    WHERE product_id = linked_id
      AND booking_date = NEW.booking_date
      AND slot = NEW.slot
      AND (TG_OP = 'INSERT' OR id <> NEW.id)
  ) THEN
    RAISE EXCEPTION 'Linked product is already booked for that date and slot';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_booking_integrity ON bookings;
CREATE TRIGGER trg_enforce_booking_integrity
BEFORE INSERT OR UPDATE ON bookings
FOR EACH ROW
EXECUTE FUNCTION enforce_booking_integrity();

-- Prevent duplicate inserts from repeated Shopify webhook deliveries
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_bookings_shopify_order_slot'
  ) THEN
    ALTER TABLE bookings
      ADD CONSTRAINT uq_bookings_shopify_order_slot
      UNIQUE (shopify_order_id, product_id, booking_date, slot);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bookings_product_date
  ON bookings(product_id, booking_date);


-- ----------------------------------------------------------------
-- TABLE 3: BLOCKED SLOTS  (manually set by you via admin panel)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blocked_slots (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id   TEXT,    -- NULL = applies to ALL products
  block_date   DATE NOT NULL,
  slot         TEXT CHECK (slot IN ('morning', 'evening', 'all')),
  -- slot = NULL or 'all' means entire day is blocked
  reason       TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blocked_slots_product_date
  ON blocked_slots(product_id, block_date);


-- ----------------------------------------------------------------
-- TABLE 4: DELIVERY ZONES  (managed via admin panel)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS delivery_zones (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  area_name  TEXT NOT NULL,
  price      DECIMAL(10, 3) NOT NULL,  -- price in KD
  is_active  BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ✏️  These are sample Kuwait areas — edit freely in the admin panel
INSERT INTO delivery_zones (area_name, price, sort_order) VALUES
  ('Kuwait City',   1.500,  1),
  ('Salmiya',       1.500,  2),
  ('Hawalli',       1.500,  3),
  ('Jabriya',       1.500,  4),
  ('Rumaithiya',    1.500,  5),
  ('Mishref',       2.000,  6),
  ('Farwaniya',     2.000,  7),
  ('Fintas',        2.500,  8),
  ('Fahaheel',      2.500,  9),
  ('Abu Halifa',    2.500, 10),
  ('Ahmadi',        3.000, 11),
  ('Mangaf',        3.000, 12)
ON CONFLICT DO NOTHING;


-- ================================================================
-- ROW LEVEL SECURITY (RLS)
-- ================================================================
-- Public (widget) can READ — needed to check availability
-- Admin panel uses the Service Role key, which bypasses all RLS
-- ================================================================

ALTER TABLE products       ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocked_slots  ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_zones ENABLE ROW LEVEL SECURITY;

-- Public read access (for booking widget availability checks)
CREATE POLICY "Public read products"
  ON products FOR SELECT USING (TRUE);

CREATE POLICY "Public read bookings"
  ON bookings FOR SELECT USING (TRUE);

CREATE POLICY "Public read blocked_slots"
  ON blocked_slots FOR SELECT USING (TRUE);

CREATE POLICY "Public read active delivery zones"
  ON delivery_zones FOR SELECT USING (is_active = TRUE);

-- ================================================================
-- ✅ DATABASE SETUP COMPLETE
-- Next step: open admin-panel.html and enter your Supabase details
-- ================================================================
