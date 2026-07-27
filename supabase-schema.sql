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

-- The partial unique index above cannot be used by ON CONFLICT inference in
-- UPSERT statements. Replace it with a full unique constraint so webhook
-- upserts (`.upsert(record, { onConflict: 'shopify_product_id' })`) resolve
-- correctly. NULL values are still treated as distinct, which is fine since
-- real product rows always have a shopify_product_id.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_products_shopify_product_id'
  ) THEN
    -- already a constraint; nothing to do
    NULL;
  ELSIF EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'uq_products_shopify_product_id'
  ) THEN
    ALTER TABLE products DROP CONSTRAINT IF EXISTS uq_products_shopify_product_id;
    ALTER TABLE products ADD CONSTRAINT uq_products_shopify_product_id UNIQUE (shopify_product_id);
  END IF;
END $$;

-- As a final safety net, ensure the constraint exists even on a fresh DB
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_products_shopify_product_id'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT uq_products_shopify_product_id UNIQUE (shopify_product_id);
  END IF;
END $$;

-- Self-reference foreign key for linked products
ALTER TABLE products
  DROP CONSTRAINT IF EXISTS fk_linked_product;

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
  delivery_governorate TEXT,
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
-- - no more than 2 bookings per slot per day across all products
CREATE OR REPLACE FUNCTION enforce_booking_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  slot_start timestamptz;
  linked_id text;
  booking_count integer;
BEGIN
  -- Cancellation/metadata-only UPDATEs (e.g. is_active toggle from the order
  -- webhook) should not be blocked by capacity or 24h-window rules. Detect by
  -- checking whether any column other than is_active actually changed.
  IF TG_OP = 'UPDATE'
     AND NEW.product_id      = OLD.product_id
     AND NEW.booking_date    = OLD.booking_date
     AND NEW.slot            = OLD.slot
     AND NEW.shopify_order_id IS NOT DISTINCT FROM OLD.shopify_order_id
     AND COALESCE(NEW.customer_name,  '') = COALESCE(OLD.customer_name,  '')
     AND COALESCE(NEW.customer_phone, '') = COALESCE(OLD.customer_phone, '')
     AND COALESCE(NEW.customer_email, '') = COALESCE(OLD.customer_email, '')
     AND COALESCE(NEW.delivery_governorate, '') = COALESCE(OLD.delivery_governorate, '')
     AND COALESCE(NEW.delivery_area, '')         = COALESCE(OLD.delivery_area, '')
     AND COALESCE(NEW.delivery_price::text, '')  = COALESCE(OLD.delivery_price::text, '')
     AND COALESCE(NEW.notes, '') = COALESCE(OLD.notes, '')
  THEN
    RETURN NEW;
  END IF;

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

  SELECT COUNT(*) INTO booking_count
  FROM bookings
  WHERE booking_date = NEW.booking_date
    AND slot = NEW.slot
    AND (TG_OP = 'INSERT' OR id <> NEW.id);

  IF booking_count >= 2 THEN
    RAISE EXCEPTION 'This slot has reached the daily capacity of 2 bookings';
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
  governorate TEXT NOT NULL,
  area_name  TEXT NOT NULL,
  price      DECIMAL(10, 3) NOT NULL,  -- price in KD
  is_active  BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS delivery_governorate TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE delivery_zones ADD COLUMN IF NOT EXISTS governorate TEXT;

-- ✏️  Delivery zones (Arabic) — edit freely in the admin panel
INSERT INTO delivery_zones (governorate, area_name, price, sort_order) VALUES
  -- محافظة العاصمة (All 3 KWD)
  ('محافظة العاصمة', 'الخالدية', 3.000, 1),
  ('محافظة العاصمة', 'الدسمة', 3.000, 2),
  ('محافظة العاصمة', 'الدعية', 3.000, 3),
  ('محافظة العاصمة', 'الدوحة', 3.000, 4),
  ('محافظة العاصمة', 'الروضة', 3.000, 5),
  ('محافظة العاصمة', 'السرة', 3.000, 6),
  ('محافظة العاصمة', 'الشامية', 3.000, 7),
  ('محافظة العاصمة', 'الشرق', 3.000, 8),
  ('محافظة العاصمة', 'الشويخ', 3.000, 9),
  ('محافظة العاصمة', 'الصالحية', 3.000, 10),
  ('محافظة العاصمة', 'الصليبيخات', 3.000, 11),
  ('محافظة العاصمة', 'الصوابر', 3.000, 12),
  ('محافظة العاصمة', 'العديلية', 3.000, 13),
  ('محافظة العاصمة', 'الفيحاء', 3.000, 14),
  ('محافظة العاصمة', 'القادسية', 3.000, 15),
  ('محافظة العاصمة', 'القبلة', 3.000, 16),
  ('محافظة العاصمة', 'المرقاب', 3.000, 17),
  ('محافظة العاصمة', 'المنصورية', 3.000, 18),
  ('محافظة العاصمة', 'النزهة', 3.000, 19),
  ('محافظة العاصمة', 'النهضة', 3.000, 20),
  ('محافظة العاصمة', 'اليرموك', 3.000, 21),
  ('محافظة العاصمة', 'برج الحمراء', 3.000, 22),
  ('محافظة العاصمة', 'بنيد القار', 3.000, 23),
  ('محافظة العاصمة', 'جابر الأحمد', 3.000, 24),
  ('محافظة العاصمة', 'شمال غرب الصليبيخات', 3.000, 25),
  ('محافظة العاصمة', 'عبدالله السالم', 3.000, 26),
  ('محافظة العاصمة', 'غرناطة', 3.000, 27),
  ('محافظة العاصمة', 'قرطبة', 3.000, 28),
  ('محافظة العاصمة', 'كيفان', 3.000, 29),
  ('محافظة العاصمة', 'مدينة الكويت', 3.000, 30),

  -- محافظة الأحمدي (3 KWD, except as noted)
  ('محافظة الأحمدي', 'علي صباح السالم - أم الهيمان', 7.000, 31),
  ('محافظة الأحمدي', 'صباح الأحمد 1', 7.000, 32),
  ('محافظة الأحمدي', 'صباح الأحمد 2', 7.000, 33),
  ('محافظة الأحمدي', 'صباح الأحمد 3', 7.000, 34),
  ('محافظة الأحمدي', 'صباح الأحمد 4', 7.000, 35),
  ('محافظة الأحمدي', 'صباح الأحمد 5', 7.000, 36),
  ('محافظة الأحمدي', 'صباح الأحمد 6', 7.000, 37),
  ('محافظة الأحمدي', 'الخيران', 10.000, 38),
  ('محافظة الأحمدي', 'الوفرة', 10.000, 39),
  ('محافظة الأحمدي', 'أبو حليفة', 3.000, 40),
  ('محافظة الأحمدي', 'الرقة', 3.000, 41),
  ('محافظة الأحمدي', 'الصباحية', 3.000, 42),
  ('محافظة الأحمدي', 'الظهر', 3.000, 43),
  ('محافظة الأحمدي', 'العقيلة', 3.000, 44),
  ('محافظة الأحمدي', 'الفحيحيل', 3.000, 45),
  ('محافظة الأحمدي', 'الفنطاس', 3.000, 46),
  ('محافظة الأحمدي', 'المنقف', 3.000, 47),
  ('محافظة الأحمدي', 'المهبولة', 3.000, 48),
  ('محافظة الأحمدي', 'جابر العلي', 3.000, 49),
  ('محافظة الأحمدي', 'الأحمدي', 3.000, 50),
  ('محافظة الأحمدي', 'فهد الأحمد', 3.000, 51),
  ('محافظة الأحمدي', 'هدية', 3.000, 52),

  -- محافظة الجهراء (3 KWD, except as noted)
  ('محافظة الجهراء', 'المطلاع', 5.000, 53),
  ('محافظة الجهراء', 'جنوب المطلاع', 5.000, 54),
  ('محافظة الجهراء', 'المطلاع N01', 5.000, 55),
  ('محافظة الجهراء', 'المطلاع N02', 5.000, 56),
  ('محافظة الجهراء', 'المطلاع N03', 5.000, 57),
  ('محافظة الجهراء', 'المطلاع N04', 5.000, 58),
  ('محافظة الجهراء', 'المطلاع N05', 5.000, 59),
  ('محافظة الجهراء', 'المطلاع N06', 5.000, 60),
  ('محافظة الجهراء', 'المطلاع N07', 5.000, 61),
  ('محافظة الجهراء', 'المطلاع N08', 5.000, 62),
  ('محافظة الجهراء', 'المطلاع N09', 5.000, 63),
  ('محافظة الجهراء', 'المطلاع N10', 5.000, 64),
  ('محافظة الجهراء', 'المطلاع N11', 5.000, 65),
  ('محافظة الجهراء', 'المطلاع N12', 5.000, 66),
  ('محافظة الجهراء', 'الصبية', 10.000, 67),
  ('محافظة الجهراء', 'العبدلي', 10.000, 68),
  ('محافظة الجهراء', 'السالمي', 10.000, 69),
  ('محافظة الجهراء', 'الجهراء', 3.000, 70),
  ('محافظة الجهراء', 'الصليبية', 3.000, 71),
  ('محافظة الجهراء', 'العيون', 3.000, 72),
  ('محافظة الجهراء', 'القصر', 3.000, 73),
  ('محافظة الجهراء', 'القيروان', 3.000, 74),
  ('محافظة الجهراء', 'النسيم', 3.000, 75),
  ('محافظة الجهراء', 'النعيم', 3.000, 76),
  ('محافظة الجهراء', 'الواحة', 3.000, 77),
  ('محافظة الجهراء', 'تيماء', 3.000, 78),
  ('محافظة الجهراء', 'سعد العبدالله', 3.000, 79),
  ('محافظة الجهراء', 'جنوب الجهراء', 3.000, 80),
  ('محافظة الجهراء', 'صليبية السكنية', 3.000, 81),

  -- محافظة الفروانية (3 KWD, except as noted)
  ('محافظة الفروانية', 'الهجن', 5.000, 82),
  ('محافظة الفروانية', 'كبد', 5.000, 83),
  ('محافظة الفروانية', 'خيطان', 3.000, 84),
  ('محافظة الفروانية', 'إشبيليا', 3.000, 85),
  ('محافظة الفروانية', 'الأندلس', 3.000, 86),
  ('محافظة الفروانية', 'الرابية', 3.000, 87),
  ('محافظة الفروانية', 'الرحاب', 3.000, 88),
  ('محافظة الفروانية', 'الرقعي', 3.000, 89),
  ('محافظة الفروانية', 'الري', 3.000, 90),
  ('محافظة الفروانية', 'الشدادية', 3.000, 91),
  ('محافظة الفروانية', 'الضجيج', 3.000, 92),
  ('محافظة الفروانية', 'العارضية', 3.000, 93),
  ('محافظة الفروانية', 'العمرية', 3.000, 94),
  ('محافظة الفروانية', 'الفردوس', 3.000, 95),
  ('محافظة الفروانية', 'الفروانية', 3.000, 96),
  ('محافظة الفروانية', 'المطار', 3.000, 97),
  ('محافظة الفروانية', 'جليب الشيوخ', 3.000, 98),
  ('محافظة الفروانية', 'جنوب عبدالله المبارك', 3.000, 99),
  ('محافظة الفروانية', 'صباح الناصر', 3.000, 100),
  ('محافظة الفروانية', 'عبدالله المبارك', 3.000, 101),
  ('محافظة الفروانية', 'غرب عبدالله المبارك', 3.000, 102),

  -- محافظة حولي (All 3 KWD)
  ('محافظة حولي', 'البدع', 3.000, 103),
  ('محافظة حولي', 'الجابرية', 3.000, 104),
  ('محافظة حولي', 'الرميثية', 3.000, 105),
  ('محافظة حولي', 'الزهراء', 3.000, 106),
  ('محافظة حولي', 'السالمية', 3.000, 107),
  ('محافظة حولي', 'السلام', 3.000, 108),
  ('محافظة حولي', 'الشعب', 3.000, 109),
  ('محافظة حولي', 'الشهداء', 3.000, 110),
  ('محافظة حولي', 'الصديق', 3.000, 111),
  ('محافظة حولي', 'بيان', 3.000, 112),
  ('محافظة حولي', 'حطين', 3.000, 113),
  ('محافظة حولي', 'حولي', 3.000, 114),
  ('محافظة حولي', 'سلوى', 3.000, 115),
  ('محافظة حولي', 'مبارك العبدالله', 3.000, 116),
  ('محافظة حولي', 'مشرف', 3.000, 117),
  ('محافظة حولي', 'ميدان حولي', 3.000, 118),

  -- محافظة مبارك الكبير (All 3 KWD)
  ('محافظة مبارك الكبير', 'أبو الحصانية', 3.000, 119),
  ('محافظة مبارك الكبير', 'أبو فطيرة', 3.000, 120),
  ('محافظة مبارك الكبير', 'أسواق القرين', 3.000, 121),
  ('محافظة مبارك الكبير', 'العدّان', 3.000, 122),
  ('محافظة مبارك الكبير', 'الفنيطيس', 3.000, 123),
  ('محافظة مبارك الكبير', 'القرين', 3.000, 124),
  ('محافظة مبارك الكبير', 'القصور', 3.000, 125),
  ('محافظة مبارك الكبير', 'المسائل', 3.000, 126),
  ('محافظة مبارك الكبير', 'المسيلة', 3.000, 127),
  ('محافظة مبارك الكبير', 'صباح السالم', 3.000, 128),
  ('محافظة مبارك الكبير', 'غرب أبو فطيرة الحرفية', 3.000, 129),
  ('محافظة مبارك الكبير', 'مبارك الكبير', 3.000, 130),
  ('محافظة مبارك الكبير', 'وسطى', 3.000, 131)
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
DROP POLICY IF EXISTS "Public read products" ON products;
CREATE POLICY "Public read products"
  ON products FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS "Public read bookings" ON bookings;
CREATE POLICY "Public read bookings"
  ON bookings FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS "Public read blocked_slots" ON blocked_slots;
CREATE POLICY "Public read blocked_slots"
  ON blocked_slots FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS "Public read active delivery zones" ON delivery_zones;
CREATE POLICY "Public read active delivery zones"
  ON delivery_zones FOR SELECT USING (is_active = TRUE);

-- ================================================================
-- ✅ DATABASE SETUP COMPLETE
-- Next step: open admin-panel.html and enter your Supabase details
-- ================================================================
