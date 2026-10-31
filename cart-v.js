/**
 * LILY SERVICE - Cart rules + Cart guard
 *
 * 1) window.LilyCartRules: ONE set of booking + delivery rules, shared by the cart page
 *    (this file), assets/delivery-fee.js and the customer info / payment page.
 * 2) Quick-add guard (all pages): main services can only be added from their product
 *    page, where the calendar sets the date and slot.
 * 3) Cart page guard: store-styled warning + locked checkout while a rule fails.
 *
 * Availability is read from the public view `booking_slots` (no customer data) and
 * live changes arrive through the one-row realtime table `availability_ping`.
 *
 * NOTE: these checks run in the customer's browser. The payment server and the
 * database trigger must enforce them too.
 */
window.LilyCartRules = window.LilyCartRules || (function () {
  'use strict';

  var ROOT = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
  var ADDON_TAG = 'non-package';
  var SLOTS_TABLE = 'booking_slots';
  var MAX_PER_SLOT = 2;
  // 24 hours (database rule) + 30 minutes safety buffer, so a customer who is slow
  // on the payment page is not rejected by the database after paying.
  var MIN_AHEAD_MS = (24 * 60 + 30) * 60 * 1000;
  var KUWAIT_UTC_OFFSET = 3; // Kuwait is UTC+3 all year (no daylight saving)
  var SLOT_START = { morning: [6, 30], evening: [14, 30] };
  var LINKED_SHOPIFY_PAIRS = [['8811194319045', '8811194548421']];
  var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

  // ===== Delivery fee products + prices (single source of truth) =====
  var DELIVERY_VARIANTS = { 3: 46164475936965, 5: 46164477182149, 7: 46164478951621, 10: 46164481343685 };
  var DELIVERY_IDS = Object.keys(DELIVERY_VARIANTS).map(function (k) { return String(DELIVERY_VARIANTS[k]); });
  var ATTR_GOV = 'Delivery Governorate';
  var ATTR_AREA = 'Delivery Area';
  var DELIVERY_DATA = {
    capital: {
      'الخالدية':3,'الدسمة':3,'الدعية':3,'الدوحة':3,'الروضة':3,'السرة':3,
      'الشامية':3,'الشرق':3,'الشويخ':3,'الصالحية':3,'الصليبيخات':3,'الصوابر':3,
      'العديلية':3,'الفيحاء':3,'القادسية':3,'القبلة':3,'المرقاب':3,'المنصورية':3,
      'النزهة':3,'النهضة':3,'اليرموك':3,'برج الحمراء':3,'بنيد القار':3,
      'جابر الأحمد':3,'شمال غرب الصليبيخات':3,'عبدالله السالم':3,
      'غرناطة':3,'قرطبة':3,'كيفان':3,'مدينة الكويت':3
    },
    ahmadi: {
      'علي صباح السالم - أم الهيمان':7,
      'صباح الأحمد 1':7,'صباح الأحمد 2':7,'صباح الأحمد 3':7,
      'صباح الأحمد 4':7,'صباح الأحمد 5':7,'صباح الأحمد 6':7,
      'الخيران':10,'الوفرة':10,
      'أبو حليفة':3,'الرقة':3,'الصباحية':3,'الظهر':3,'العقيلة':3,
      'الفحيحيل':3,'الفنطاس':3,'المنقف':3,'المهبولة':3,
      'جابر العلي':3,'الأحمدي':3,'فهد الأحمد':3,'هدية':3
    },
    jahra: {
      'المطلاع':5,'جنوب المطلاع':5,
      'المطلاع N01':5,'المطلاع N02':5,'المطلاع N03':5,'المطلاع N04':5,
      'المطلاع N05':5,'المطلاع N06':5,'المطلاع N07':5,'المطلاع N08':5,
      'المطلاع N09':5,'المطلاع N10':5,'المطلاع N11':5,'المطلاع N12':5,
      'الصبية':10,'العبدلي':10,'السالمي':10,
      'الجهراء':3,'الصليبية':3,'العيون':3,'القصر':3,'القيروان':3,
      'النسيم':3,'النعيم':3,'الواحة':3,'تيماء':3,'سعد العبدالله':3,
      'جنوب الجهراء':3,'صليبية السكنية':3
    },
    farwaniya: {
      'الهجن':5,'كبد':5,
      'خيطان':3,'إشبيليا':3,'الأندلس':3,'الرابية':3,'الرحاب':3,
      'الرقعي':3,'الري':3,'الشدادية':3,'الضجيج':3,'العارضية':3,
      'العمرية':3,'الفردوس':3,'الفروانية':3,'المطار':3,
      'جليب الشيوخ':3,'جنوب عبدالله المبارك':3,
      'صباح الناصر':3,'عبدالله المبارك':3,'غرب عبدالله المبارك':3
    },
    hawalli: {
      'البدع':3,'الجابرية':3,'الرميثية':3,'الزهراء':3,'السالمية':3,
      'السلام':3,'الشعب':3,'الشهداء':3,'الصديق':3,'بيان':3,
      'حطين':3,'حولي':3,'سلوى':3,'مبارك العبدالله':3,
      'مشرف':3,'ميدان حولي':3
    },
    mubarak: {
      'أبو الحصانية':3,'أبو فطيرة':3,'أسواق القرين':3,'العدّان':3,
      'الفنيطيس':3,'القرين':3,'القصور':3,'المسائل':3,
      'المسيلة':3,'صباح السالم':3,'غرب أبو فطيرة الحرفية':3,
      'مبارك الكبير':3,'وسطى':3
    }
  };

  // Arabic first, English on the next line
  function bi(ar, en) { return ar + '\n' + en; }
  var SLOT_AR = { morning: 'الفترة الصباحية', evening: 'الفترة المسائية' };
  function quoteName(name) { return '«' + name + '»'; }

  function uniq(a) { return a.filter(function (v, i) { return v && a.indexOf(v) === i; }); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function isDelivery(item) { return DELIVERY_IDS.indexOf(String(item.variant_id)) !== -1; }
  function feeFor(gov, area) { return (gov && area && DELIVERY_DATA[gov] && DELIVERY_DATA[gov][area]) || null; }
  function variantForArea(gov, area) { var f = feeFor(gov, area); return f ? DELIVERY_VARIANTS[f] : null; }
  function hasAddonTag(tags) { return (tags || []).some(function (t) { return String(t).toLowerCase() === ADDON_TAG; }); }

  // ===== Product tags, cached for the browser session =====
  var tagCache = {};
  function productTags(handle) {
    if (!handle) return Promise.resolve(null);
    if (tagCache[handle]) return tagCache[handle];
    try {
      var saved = sessionStorage.getItem('lily_tags_' + handle);
      if (saved) { tagCache[handle] = Promise.resolve(JSON.parse(saved)); return tagCache[handle]; }
    } catch (e) {}
    tagCache[handle] = fetch(ROOT + 'products/' + encodeURIComponent(handle) + '.js', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (p) {
        if (!p) throw new Error('no product');
        var tags = Array.isArray(p.tags) ? p.tags.map(String) : [];
        try { sessionStorage.setItem('lily_tags_' + handle, JSON.stringify(tags)); } catch (e) {}
        return tags;
      })
      .catch(function () { delete tagCache[handle]; return null; });
    return tagCache[handle];
  }

  function isAddOnUrl(url) {
    var m = String(url || '').match(/\/products\/([^/?#]+)/);
    if (!m) return Promise.resolve(false);
    return productTags(decodeURIComponent(m[1])).then(function (t) { return !!t && hasAddonTag(t); });
  }

  // ===== Reading the booking date/slot from a cart line =====
  function toYMD(val) {
    var s = String(val || '').trim();
    if (!s) return null;
    var iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
    var long = s.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
    if (long) {
      var mi = MONTHS.indexOf(long[2].toLowerCase());
      if (mi !== -1) return long[3] + '-' + pad(mi + 1) + '-' + pad(+long[1]);
    }
    return null;
  }

  function toSlot(val) {
    var s = String(val || '').toLowerCase();
    if (!s) return null;
    if (s.indexOf('morning') !== -1) return 'morning';
    if (s.indexOf('evening') !== -1) return 'evening';
    if (s.indexOf('pm') !== -1) return 'evening';
    if (s.indexOf('am') !== -1) return 'morning';
    return null;
  }

  function readBooking(item) {
    var p = item.properties || {};
    var props = {};
    if (Array.isArray(p)) p.forEach(function (x) { if (x && x.name) props[x.name] = x.value; });
    else props = p;

    var date = props._bk_date ? toYMD(props._bk_date) : null;
    var slot = props._bk_slot ? toSlot(props._bk_slot) : null;
    Object.keys(props).forEach(function (k) {
      if (k.charAt(0) === '_' || !props[k]) return;
      var n = k.toLowerCase();
      if (!date && n.indexOf('date') !== -1) date = toYMD(props[k]);
      if (!slot && n.indexOf('slot') !== -1) slot = toSlot(props[k]);
    });
    return { date: date, slot: slot };
  }

  function slotStartMs(ymd, slot) {
    var a = ymd.split('-').map(Number);
    var t = SLOT_START[slot];
    return Date.UTC(a[0], a[1] - 1, a[2], t[0] - KUWAIT_UTC_OFFSET, t[1]);
  }

  function fetchCart() {
    return fetch(ROOT + 'cart.js', { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (r) {
        var serverNow = Date.parse(r.headers.get('Date') || '');
        return r.json().then(function (cart) {
          return { cart: cart, now: isNaN(serverNow) ? Date.now() : serverNow };
        });
      });
  }

  /**
   * validate({ sb, strict, checkDelivery, requireItems })
   * Returns { ok, error, transient, cart, bookings }
   */
  async function validate(opts) {
    opts = opts || {};
    var cart = null;
    function fail(msg, transient) { return { ok: false, error: msg, transient: !!transient, cart: cart }; }

    var fc;
    try { fc = await fetchCart(); } catch (e) { return fail(bi('تعذر تحميل السلة. يرجى المحاولة مرة أخرى.', 'Could not load your cart. Please try again.'), true); }
    cart = fc.cart;
    var now = fc.now;
    var items = cart.items || [];
    var real = items.filter(function (i) { return !isDelivery(i); });

    if (!real.length) {
      return opts.requireItems ? fail(bi('السلة فارغة.', 'Your cart is empty.')) : { ok: true, cart: cart, bookings: [] };
    }

    // 1. Main services vs add-ons (tag "non-package" = add-on, never a booking)
    var tags = await Promise.all(real.map(function (i) { return productTags(i.handle); }));
    var mains = [];
    var addons = [];
    for (var t = 0; t < real.length; t++) {
      if (tags[t] === null) {
        if (opts.strict) return fail(bi('تعذر التحقق من المنتجات في السلة. يرجى المحاولة مرة أخرى.', 'Could not verify the products in your cart. Please try again.'), true);
        continue;
      }
      (hasAddonTag(tags[t]) ? addons : mains).push(real[t]);
    }

    // 2. Add-ons need a main service
    if (addons.length && !mains.length) {
      return fail(bi('لا يمكن شراء الإضافات إلا مع باكج رئيسي. يرجى إضافة باكج إلى السلة.', 'Add-on products can only be purchased with a main service. Please add a main service to your cart.'));
    }

    // 3. Every main service: date + slot, quantity 1, far enough ahead
    var bookings = [];
    for (var i = 0; i < mains.length; i++) {
      var m = mains[i];
      var name = m.product_title || m.title || 'This product';
      var b = readBooking(m);
      if (!b.date || !b.slot) {
        return fail(bi(quoteName(name) + ' بدون تاريخ وفترة توصيل. يرجى حذفه وإضافته مرة أخرى من صفحة المنتج.', '"' + name + '" has no delivery date and time slot. Please remove it and add it again from its product page.'));
      }
      if (m.quantity !== 1) {
        return fail(bi('يمكن حجز ' + quoteName(name) + ' مرة واحدة فقط لكل تاريخ وفترة. يرجى جعل الكمية 1.', '"' + name + '" can only be booked once per date and slot. Please set its quantity to 1.'));
      }
      if (slotStartMs(b.date, b.slot) - now < MIN_AHEAD_MS) {
        return fail(bi('موعد توصيل ' + quoteName(name) + ' (' + b.date + '، ' + SLOT_AR[b.slot] + ') بعد أقل من 24 ساعة. يرجى حذفه واختيار تاريخ جديد.', 'The delivery time for "' + name + '" (' + b.date + ', ' + b.slot + ') is less than 24 hours away. Please remove it and choose a new date.'));
      }
      bookings.push({ name: name, date: b.date, slot: b.slot, shopifyId: String(m.product_id) });
    }

    // 4. Same product twice for one date + slot
    var seen = {};
    for (var d = 0; d < bookings.length; d++) {
      var key = bookings[d].shopifyId + '|' + bookings[d].date + '|' + bookings[d].slot;
      if (seen[key]) return fail(bi(quoteName(bookings[d].name) + ' موجود في السلة مرتين لتاريخ ' + bookings[d].date + ' (' + SLOT_AR[bookings[d].slot] + '). يرجى حذف المكرر.', '"' + bookings[d].name + '" is in your cart twice for ' + bookings[d].date + ' (' + bookings[d].slot + '). Please remove the duplicate.'));
      seen[key] = true;
    }

    // 5. Delivery fee must match the chosen area
    if (opts.checkDelivery) {
      var fees = items.filter(isDelivery);
      var attrs = cart.attributes || {};
      var expected = variantForArea(attrs[ATTR_GOV], attrs[ATTR_AREA]);
      if (!expected || fees.length !== 1 || fees[0].quantity !== 1 || String(fees[0].variant_id) !== String(expected)) {
        return fail(bi('يرجى اختيار منطقة التوصيل في السلة قبل الدفع.', 'Please select your delivery area in the cart before paying.'));
      }
    }

    if (!bookings.length) return { ok: true, cart: cart, bookings: bookings };

    // 6. Live availability: existing bookings, blocked slots, paired stands, capacity (including this cart)
    var sb = opts.sb;
    if (!sb) {
      return opts.strict
        ? fail(bi('تعذر التحقق من التوفر. يرجى تحديث الصفحة والمحاولة مرة أخرى.', 'Could not check availability. Please refresh the page and try again.'), true)
        : { ok: true, cart: cart, bookings: bookings, unchecked: true };
    }

    var dates = uniq(bookings.map(function (x) { return x.date; }));
    var res;
    try {
      res = await Promise.all([
        sb.from('products').select('id, shopify_product_id, linked_product_id'),
        sb.from(SLOTS_TABLE).select('booking_date, slot, product_id').eq('is_active', true).in('booking_date', dates),
        sb.from('blocked_slots').select('block_date, slot, product_id').in('block_date', dates)
      ]);
    } catch (e) {
      return fail(bi('تعذر التحقق من التوفر. يرجى المحاولة مرة أخرى.', 'Could not check availability. Please try again.'), true);
    }
    for (var r = 0; r < res.length; r++) {
      if (res[r].error) return fail(bi('تعذر التحقق من التوفر. يرجى المحاولة مرة أخرى.', 'Could not check availability. Please try again.'), true);
    }
    var products = res[0].data || [];
    var booked = res[1].data || [];
    var blocked = res[2].data || [];

    var dbByShopify = {};
    var rowByDb = {};
    products.forEach(function (p) {
      if (p.shopify_product_id) dbByShopify[String(p.shopify_product_id)] = String(p.id);
      rowByDb[String(p.id)] = p;
    });
    function keysFor(shopifyId) {
      var k = [shopifyId];
      if (dbByShopify[shopifyId]) k.push(dbByShopify[shopifyId]);
      return k;
    }
    function linkedKeys(shopifyId) {
      var out = [];
      var db = dbByShopify[shopifyId];
      if (db && rowByDb[db] && rowByDb[db].linked_product_id) out.push(String(rowByDb[db].linked_product_id));
      products.forEach(function (p) {
        if (db && p.linked_product_id && String(p.linked_product_id) === db) out.push(String(p.id));
      });
      LINKED_SHOPIFY_PAIRS.forEach(function (pair) {
        var other = pair[0] === shopifyId ? pair[1] : (pair[1] === shopifyId ? pair[0] : null);
        if (other) out = out.concat(keysFor(other));
      });
      out.slice().forEach(function (k) {
        var row = rowByDb[k];
        if (row && row.shopify_product_id) out.push(String(row.shopify_product_id));
      });
      return uniq(out);
    }
    function matches(pid, list) { return pid != null && list.indexOf(String(pid)) !== -1; }

    bookings.forEach(function (x) { x.keys = keysFor(x.shopifyId); x.linked = linkedKeys(x.shopifyId); });

    var groups = {};
    bookings.forEach(function (x) {
      var k = x.date + '|' + x.slot;
      (groups[k] = groups[k] || []).push(x);
    });

    var groupKeys = Object.keys(groups);
    for (var gi = 0; gi < groupKeys.length; gi++) {
      var g = groups[groupKeys[gi]];
      var date = g[0].date;
      var slot = g[0].slot;
      var existing = booked.filter(function (x) { return x.booking_date === date && x.slot === slot; });

      for (var j = 0; j < g.length; j++) {
        var bk = g[j];
        if (existing.some(function (x) { return matches(x.product_id, bk.keys); })) {
          return fail(bi(quoteName(bk.name) + ' محجوز بالفعل في ' + date + ' (' + SLOT_AR[slot] + '). يرجى اختيار وقت آخر.', '"' + bk.name + '" is already booked for ' + date + ' (' + slot + '). Please choose another time.'));
        }
        if (existing.some(function (x) { return matches(x.product_id, bk.linked); })) {
          return fail(bi(quoteName(bk.name) + ' غير متاح في ' + date + ' (' + SLOT_AR[slot] + ') لأن الستاند المرتبط به محجوز. يرجى اختيار وقت آخر.', '"' + bk.name + '" is not available on ' + date + ' (' + slot + ') because its paired stand is already booked. Please choose another time.'));
        }
        if (blocked.some(function (x) {
          return x.block_date === date &&
            (!x.slot || x.slot === 'all' || x.slot === slot) &&
            (!x.product_id || matches(x.product_id, bk.keys));
        })) {
          return fail(bi(quoteName(bk.name) + ' غير متاح في ' + date + ' (' + SLOT_AR[slot] + '). يرجى اختيار وقت آخر.', '"' + bk.name + '" is not available on ' + date + ' (' + slot + '). Please choose another time.'));
        }
        for (var q = j + 1; q < g.length; q++) {
          var other = g[q];
          if (bk.linked.some(function (k) { return other.keys.indexOf(k) !== -1; })) {
            return fail(bi('لا يمكن حجز ' + quoteName(bk.name) + ' و' + quoteName(other.name) + ' في نفس التاريخ والفترة. يرجى تغيير أحدهما.', '"' + bk.name + '" and "' + other.name + '" cannot be booked for the same date and slot. Please change one of them.'));
          }
        }
      }

      if (existing.length + g.length > MAX_PER_SLOT) {
        var left = Math.max(0, MAX_PER_SLOT - existing.length);
        return fail(bi(SLOT_AR[slot] + ' في ' + date + ': ' + (left ? 'متبقٍ ' + left + ' مكان فقط' : 'لا يوجد مكان متبقٍ') + '، وفي سلتك ' + g.length + ' حجز لهذه الفترة. يرجى نقل أحدها إلى وقت آخر.', 'The ' + slot + ' slot on ' + date + ' has ' + left + ' place' + (left === 1 ? '' : 's') + ' left, but your cart has ' + g.length + ' booking' + (g.length === 1 ? '' : 's') + ' for it. Please move one to another time.'));
      }
    }

    return { ok: true, cart: cart, bookings: bookings };
  }

  return {
    ROOT: ROOT,
    ATTR_GOV: ATTR_GOV,
    ATTR_AREA: ATTR_AREA,
    DELIVERY_VARIANTS: DELIVERY_VARIANTS,
    DELIVERY_DATA: DELIVERY_DATA,
    MIN_AHEAD_MS: MIN_AHEAD_MS,
    isDelivery: isDelivery,
    variantForArea: variantForArea,
    productTags: productTags,
    isAddOnUrl: isAddOnUrl,
    readBooking: readBooking,
    fetchCart: fetchCart,
    validate: validate
  };
})();

(function () {
  'use strict';
  var R = window.LilyCartRules;

  var sb = null;
  try {
    sb = supabase.createClient(
      'https://adcjzrstjrdxzfobcfbl.supabase.co',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFkY2p6cnN0anJkeHpmb2JjZmJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxOTY0MDYsImV4cCI6MjA5Mjc3MjQwNn0.vDPAwlOAr9OaGHU-unHI3l3_guja_wLjhCAivZ8nscA'
    );
  } catch (e) {
    console.warn('[cart-guard] Supabase unavailable:', e);
  }

  // ============================================================
  // QUICK-ADD GUARD (every page)
  // A product form with an EMPTY calendar date that the product page's own guard
  // didn't handle (quick add on collections, "You may also like", etc.) is a main
  // service added without a date: send the customer to its product page instead.
  // (Add-ons have no calendar, so their forms are never touched.)
  // ============================================================
  var DATE_FIELD = 'input[name="properties[📅 Date]"]';
  window.addEventListener('submit', function (e) {
    if (window.__lilyQuickApproved) return;
    var form = e.target;
    if (!form || !form.querySelector) return;
    var dateInput = form.querySelector(DATE_FIELD);
    if (!dateInput || dateInput.value) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    var pfc = form.closest('product-form-component');
    var url = pfc && pfc.dataset.productUrl;
    if (!url) return;

    R.isAddOnUrl(url).then(function (isAddon) {
      if (isAddon) {
        window.__lilyQuickApproved = true;
        try {
          if (form.requestSubmit) form.requestSubmit();
        } finally {
          window.__lilyQuickApproved = false;
        }
      } else {
        window.location.href = url;
      }
    });
  }, true);

  // ============================================================
  // CART PAGE GUARD
  // ============================================================
  // Multi-line (Arabic + English) warnings everywhere they are shown
  try {
    var st = document.createElement('style');
    st.textContent =
      '#bk-cart-error, #bk-err, #knet-validation-error { white-space: pre-line; }' +
      // Bookings are always quantity 1 and the delivery fee is managed for the customer:
      // hide their +/- controls (and the fee's delete button) so they cannot be changed.
      '.lily-fixed-qty .quantity-selector { display: none !important; }' +
      '.cart-items__table-row:has(a[href*="/products/delivery-fee-"]) .quantity-selector,' +
      '.cart-items__table-row:has(a[href*="/products/delivery-fee-"]) .cart-items__remove { display: none !important; }';
    (document.head || document.documentElement).appendChild(st);
  } catch (e) {}

  function isCartPage() {
    return /\/cart\/?$/.test(window.location.pathname);
  }
  if (!isCartPage()) return;

  // A cart line is a booking when it shows the calendar date property
  function markFixedQuantityRows() {
    document.querySelectorAll('tr.cart-items__table-row').forEach(function (row) {
      if (row.classList.contains('lily-fixed-qty')) return;
      var dts = row.querySelectorAll('.cart-items__property dt');
      for (var i = 0; i < dts.length; i++) {
        if (dts[i].textContent.indexOf('Date') !== -1) { row.classList.add('lily-fixed-qty'); return; }
      }
    });
  }

  var last = null;
  var running = false;
  var pending = false;
  var checking = false; // a cart change is being re-checked: no stale warning, checkout held

  function getCheckoutButton() {
    return document.getElementById('checkout-customer-btn');
  }

  function showBanner(message) {
    var banner = document.getElementById('bk-cart-error');
    if (!banner) {
      var container = document.querySelector('.cart-page__items, .cart-page, cart-items-component');
      if (!container) return;
      banner = document.createElement('div');
      banner.id = 'bk-cart-error';
      banner.className = 'lily-notice';
      banner.setAttribute('role', 'alert');
      banner.setAttribute('dir', 'auto');
      container.prepend(banner);
    }
    if (banner.textContent !== message) banner.textContent = message;
    if (banner.style.display) banner.style.display = '';
  }

  function hideBanner() {
    var banner = document.getElementById('bk-cart-error');
    if (banner && banner.style.display !== 'none') banner.style.display = 'none';
  }

  function lockCheckout(label) {
    var btn = getCheckoutButton();
    if (!btn) return;
    label = label || 'Checkout unavailable';
    if (!btn.dataset.originalText) btn.dataset.originalText = btn.textContent;
    if (!btn.disabled) btn.disabled = true;
    if (btn.style.opacity !== '0.5') btn.style.opacity = '0.5';
    if (btn.style.pointerEvents !== 'none') btn.style.pointerEvents = 'none';
    if (btn.textContent.trim() !== label) btn.textContent = label;
  }

  function unlockCheckout() {
    var btn = getCheckoutButton();
    if (!btn || !btn.dataset.originalText) return;
    btn.textContent = btn.dataset.originalText;
    delete btn.dataset.originalText;
    btn.style.opacity = '';
    btn.style.pointerEvents = '';
    btn.disabled = btn.dataset.deliveryReady === 'false';
  }

  function apply() {
    markFixedQuantityRows();
    if (checking) {
      hideBanner();
      lockCheckout('Checking… جارٍ التحقق');
      return;
    }
    if (!last) return;
    if (!last.ok && !last.transient) {
      lockCheckout();
      showBanner(last.error);
    } else {
      unlockCheckout();
      hideBanner();
    }
  }

  function check() {
    if (running) { pending = true; return; }
    running = true;
    R.validate({ sb: sb })
      .then(function (res) { last = res; })
      .catch(function (err) { console.error('[cart-guard] validation failed:', err); })
      .finally(function () {
        running = false;
        if (pending) { pending = false; check(); return; }
        checking = false;
        apply();
      });
  }

  // Re-check right after any change to the cart, however the theme makes it
  function cartChanged() {
    checking = true;
    apply();
    check();
  }
  try {
    var origFetch = window.fetch;
    window.fetch = function (input) {
      var url = String((input && input.url) || input || '');
      var p = origFetch.apply(this, arguments);
      if (/\/cart\/(add|change|update|clear)(\.js)?(\?|$)/.test(url)) {
        checking = true;
        apply();
        p.then(function () { check(); }, function () { check(); });
      }
      return p;
    };
  } catch (e) {}

  var scheduled = false;
  new MutationObserver(function () {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () { scheduled = false; apply(); });
  }).observe(document.body, { childList: true, subtree: true });

  document.addEventListener('cart:update', function () { cartChanged(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') check();
  });
  window.addEventListener('pageshow', function () { check(); });

  setInterval(function () {
    if (document.visibilityState === 'visible') check();
  }, 5000);

  // Instant re-check whenever bookings or blocked slots change (no customer data is sent)
  if (sb) {
    try {
      sb.channel('cart-guard-live-' + Math.random().toString(36).slice(2, 8))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'availability_ping' }, function () { check(); })
        .subscribe();
    } catch (e) {
      console.warn('[cart-guard] realtime unavailable:', e);
    }
  }

  check();
})();
