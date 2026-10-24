/**
 * LILY SERVICE - Cart Availability Guard
 * Source for the theme file: assets/cart-v.js
 * Loaded in layout/theme.liquid (after supabase-js):
 *   <script src="{{ 'cart-v.js' | asset_url }}" defer></script>
 *
 * Locks the checkout button when a booked item in the cart can no longer be
 * booked. Same rules as the product-page widget and the database:
 *  - package rule (cart can't be only "non-package" tagged items)
 *  - same product + date + slot only once in the cart, quantity 1
 *  - product already booked for that slot
 *  - linked product (Dafwa ↔ Naseem) booked for that slot
 *  - slot blocked by admin
 *  - max 2 bookings per slot per day
 *  - slot must still be at least 24 hours away (Kuwait time)
 */

(async function () {
  'use strict';

  const CONFIG = {
    supabaseUrl: "https://adcjzrstjrdxzfobcfbl.supabase.co",
    supabaseKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFkY2p6cnN0anJkeHpmb2JjZmJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxOTY0MDYsImV4cCI6MjA5Mjc3MjQwNn0.vDPAwlOAr9OaGHU-unHI3l3_guja_wLjhCAivZ8nscA",
    maxCapacity: 2,
    slotsTable: 'booking_slots', // public view without customer data
    packageTag: 'non-package',
    linkedPairs: [["8811194319045", "8811194548421"]], // Shopify ids, same as widget
  };

  const sb = supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);

  let validationRunning = false;
  let rerunRequested = false;
  let lockedMessage = null; // current lock state, so the DOM is only touched on change

  function getCheckoutButton() {
    const selectors = ['#checkout-customer-btn', 'button[name="checkout"]', '#checkout', '.btn-checkout', '.cart__checkout-button', '.checkout-button', '.checkout-btn', '[data-checkout-button]', 'form[action="/cart"] [type="submit"]'];
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function showSlotError(message) {
    let banner = document.getElementById('bk-cart-error');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'bk-cart-error';
      banner.style.cssText = `background: #FFF0EE; color: #B42318; border: 1px solid #F5C6C2; padding: 15px; margin: 20px 0; font-family: sans-serif; font-weight: 600; font-size: 14px; text-align: center; z-index: 9999; position: relative;`;
      const cartContainer = document.querySelector('.cart-container, #main-cart, .cart__wrapper, .cart-drawer, .cart-items') || document.body;
      cartContainer.prepend(banner);
    }
    if (banner.textContent !== '⚠️ ' + message) banner.textContent = '⚠️ ' + message;
    if (banner.style.display !== 'block') banner.style.display = 'block';
  }

  function hideSlotError() {
    const banner = document.getElementById('bk-cart-error');
    if (banner && banner.style.display !== 'none') banner.style.display = 'none';
  }

  function lock(message) {
    const btn = getCheckoutButton();
    if (btn && !btn.dataset.bkLocked) {
      btn.dataset.originalText = btn.textContent;
      btn.dataset.bkLocked = '1';
      btn.disabled = true;
      btn.style.opacity = '0.5';
      btn.style.pointerEvents = 'none';
      btn.textContent = 'Slot Unavailable';
    }
    showSlotError(message);
    lockedMessage = message;
  }

  function unlock() {
    const btn = getCheckoutButton();
    if (btn && btn.dataset.bkLocked) {
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
      btn.textContent = btn.dataset.originalText || btn.textContent;
      delete btn.dataset.bkLocked;
    }
    hideSlotError();
    lockedMessage = null;
  }

  // ── Booking properties on a cart line ─────────────────────────────
  const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

  function propValue(props, name) {
    if (!props) return null;
    if (Array.isArray(props)) {
      const hit = props.find(p => p && p.name === name);
      return hit ? hit.value : null;
    }
    return typeof props === 'object' && props[name] != null ? props[name] : null;
  }

  // 'YYYY-MM-DD' from "2026-10-24" or "Saturday, 24 October 2026" (no timezone shifts)
  function parseDate(v) {
    if (!v) return null;
    const iso = String(v).match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const dmy = String(v).match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
    if (dmy && MONTHS[dmy[2].toLowerCase()]) {
      return `${dmy[3]}-${String(MONTHS[dmy[2].toLowerCase()]).padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    }
    return null;
  }

  function parseSlot(v) {
    const s = String(v || '').toLowerCase();
    if (!s) return null;
    if (s === 'morning' || s === 'evening') return s;
    return (s.includes('evening') || s.includes('2:30') || s.includes('14:30') || s.includes('pm')) ? 'evening' : 'morning';
  }

  function readBooking(item) {
    const p = item.properties;
    const date = parseDate(propValue(p, '_bk_date')) || parseDate(propValue(p, '📅 Date'));
    const slot = parseSlot(propValue(p, '_bk_slot')) || parseSlot(propValue(p, '⏰ Slot'));
    return date && slot ? { date, slot } : null;
  }

  // 06:30 / 14:30 Kuwait (UTC+3) must be at least 24h away
  function slotStillBookable(dateStr, slot) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const startUtc = Date.UTC(y, m - 1, d, slot === 'morning' ? 6 : 14, 30) - 3 * 60 * 60 * 1000;
    return startUtc >= Date.now() + 24 * 60 * 60 * 1000;
  }

  function linkedShopifyId(shopifyId) {
    for (const [a, b] of CONFIG.linkedPairs) {
      if (a === shopifyId) return b;
      if (b === shopifyId) return a;
    }
    return null;
  }

  // ── Package rule (unchanged behaviour) ────────────────────────────
  // A cart made only of products tagged `non-package` can't check out.
  // `/cart.js` has no tags, so they're fetched once per product and cached.
  const tagCache = new Map();

  async function hasTag(item, tag) {
    const tags = item.tags || [];
    if (tags.some(t => String(t).toLowerCase() === tag.toLowerCase())) return true;
    if (!item.handle) return false;
    if (!tagCache.has(item.handle)) {
      tagCache.set(item.handle, (async () => {
        try {
          const res = await fetch(`/products/${encodeURIComponent(item.handle)}.js`);
          if (!res.ok) return [];
          const product = await res.json();
          return Array.isArray(product.tags) ? product.tags : [];
        } catch (err) {
          tagCache.delete(item.handle); // retry next time
          return [];
        }
      })());
    }
    const fetched = await tagCache.get(item.handle);
    return fetched.some(t => String(t).toLowerCase() === tag.toLowerCase());
  }

  async function validatePackageRule(cart, tag) {
    try {
      const items = (cart && cart.items) || [];
      if (!items.length) return null;
      let packageCount = 0;
      for (const item of items) {
        if (await hasTag(item, tag)) packageCount++;
      }
      if (packageCount === items.length) {
        return `Your cart contains only package items. Please add at least one non-package item to check out.`;
      }
      return null;
    } catch (err) {
      console.error('Package rule check failed:', err);
      return null;
    }
  }

  // ── Booking rules ─────────────────────────────────────────────────
  async function validateBookings(cart) {
    const bookingItems = [];
    for (const item of cart.items || []) {
      const b = readBooking(item);
      if (b) bookingItems.push({ ...b, product_id: String(item.product_id), quantity: Number(item.quantity || 1), title: item.product_title || item.title });
    }
    if (!bookingItems.length) return null;

    // Shopify ids → DB ids (bookings table keys)
    const shopifyIds = new Set();
    bookingItems.forEach(b => {
      shopifyIds.add(b.product_id);
      const l = linkedShopifyId(b.product_id);
      if (l) shopifyIds.add(l);
    });
    const { data: products, error: prodErr } = await sb
      .from('products')
      .select('id, shopify_product_id, linked_product_id')
      .in('shopify_product_id', [...shopifyIds]);
    if (prodErr) throw prodErr;
    const byShopify = {};
    (products || []).forEach(p => { byShopify[String(p.shopify_product_id)] = p; });

    const seen = new Set();
    for (const item of bookingItems) {
      if (item.quantity > 1) {
        return `Only one "${item.title}" can be booked per delivery slot. Please set the quantity to 1.`;
      }
      const key = `${item.product_id}::${item.date}::${item.slot}`;
      if (seen.has(key)) {
        return `This product is already in your cart for ${item.date} ${item.slot}. Please remove the duplicate.`;
      }
      seen.add(key);

      if (!slotStillBookable(item.date, item.slot)) {
        return `The ${item.slot} slot on ${item.date} is now less than 24 hours away. Please remove it and choose another time.`;
      }
    }

    // One query per distinct date covers capacity, own-product and linked checks.
    const dates = [...new Set(bookingItems.map(b => b.date))];
    const [{ data: slots, error: slotErr }, { data: blocks, error: blockErr }] = await Promise.all([
      sb.from(CONFIG.slotsTable).select('product_id, booking_date, slot').in('booking_date', dates),
      sb.from('blocked_slots').select('product_id, block_date, slot').in('block_date', dates),
    ]);
    if (slotErr) throw slotErr;
    if (blockErr) throw blockErr;

    for (const item of bookingItems) {
      const row = byShopify[item.product_id];
      const dbId = row ? row.id : null;
      const linkedIds = new Set();
      if (row && row.linked_product_id) linkedIds.add(row.linked_product_id);
      const linkedRow = byShopify[linkedShopifyId(item.product_id)];
      if (linkedRow) linkedIds.add(linkedRow.id);

      const inSlot = (slots || []).filter(s => s.booking_date === item.date && s.slot === item.slot);

      if (dbId && inSlot.some(s => s.product_id === dbId)) {
        return `This product is already booked for the ${item.date} ${item.slot} slot. Please choose another time.`;
      }
      if (inSlot.some(s => linkedIds.has(s.product_id))) {
        return `The ${item.date} ${item.slot} slot is no longer available for this product. Please choose another time.`;
      }
      const blocked = (blocks || []).some(b =>
        b.block_date === item.date &&
        (!b.product_id || b.product_id === dbId) &&
        (!b.slot || b.slot === 'all' || b.slot === item.slot));
      if (blocked) {
        return `The ${item.date} ${item.slot} slot is no longer available. Please choose another time.`;
      }
      if (inSlot.length >= CONFIG.maxCapacity) {
        return `The delivery slot for ${item.date} (${item.slot}) is no longer available.`;
      }
    }
    return null;
  }

  async function validateCart() {
    if (validationRunning) { rerunRequested = true; return; }
    validationRunning = true;
    try {
      const response = await fetch('/cart.js', { cache: 'no-store' });
      const cart = await response.json();

      const problem =
        (await validatePackageRule(cart, CONFIG.packageTag)) ||
        (await validateBookings(cart));

      if (problem) lock(problem);
      else if (lockedMessage !== null || document.getElementById('bk-cart-error')) unlock();
    } catch (err) {
      // Network/DB hiccup: keep the current state; the next run retries.
      console.error('Cart Guard Error:', err);
    } finally {
      validationRunning = false;
      if (rerunRequested) { rerunRequested = false; setTimeout(validateCart, 50); }
    }
  }

  // ── Triggers ──────────────────────────────────────────────────────
  // Instant: the DB bumps availability_ping when bookings/blocked slots change.
  try {
    sb.channel('cart-guard-live-' + Math.random().toString(36).slice(2, 8))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'availability_ping' }, () => validateCart())
      .subscribe();
  } catch (e) {
    console.error('Realtime subscription failed:', e);
  }

  const onTabVisible = () => {
    if (document.visibilityState !== 'hidden') validateCart();
  };
  document.addEventListener('visibilitychange', onTabVisible);
  window.addEventListener('focus', onTabVisible);
  window.addEventListener('pageshow', onTabVisible);

  // Fallback poll while visible (realtime sockets can be suspended in background tabs).
  setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    validateCart();
  }, 1000);

  // AJAX carts re-render: re-check, debounced. Our own banner/button edits
  // are ignored so they don't trigger endless re-validation.
  let observerTimer = null;
  const observer = new MutationObserver((mutations) => {
    const relevant = mutations.some(m => {
      const t = m.target;
      return !(t && t.nodeType === 1 && (t.id === 'bk-cart-error' || (t.dataset && t.dataset.bkLocked !== undefined)));
    });
    if (!relevant || !getCheckoutButton()) return;
    clearTimeout(observerTimer);
    observerTimer = setTimeout(validateCart, 150);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  validateCart();

  document.addEventListener('cart:update', validateCart);
  document.addEventListener('cart:change', validateCart);
  document.addEventListener('cart:refresh', validateCart);
  document.addEventListener('shopify:cart:updated', validateCart);

})();
