
// /**
//  * LILY SERVICE - Cart Availability Guard
//  * FINAL VERSION - Fixed ReferenceError and Date Timezones
//  */

// (async function () {
//   'use strict';

//   console.log('🚀 Lily Cart Guard: Initializing...');

//   // ============================================================
//   // 1. CONFIGURATION
//   // ============================================================
//   const BK_SUPABASE_URL = "https://adcjzrstjrdxzfobcfbl.supabase.co";
//   const BK_SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFkY2p6cnN0anJkeHpmb2JjZmJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxOTY0MDYsImV4cCI6MjA5Mjc3MjQwNn0.vDPAwlOAr9OaGHU-unHI3l3_guja_wLjhCAivZ8nscA";
//   const MAX_BOOKINGS_PER_SLOT = 2; // <--- THIS WAS THE MISSING PIECE

//   // Initialize Supabase client
//   let sb;
//   try {
//     sb = supabase.createClient(BK_SUPABASE_URL, BK_SUPABASE_KEY);
//   } catch (e) {
//     console.error('❌ Supabase Client Init Failed:', e);
//     return;
//   }

//   // ============================================================
//   // 2. DOM UTILITIES
//   // ============================================================
//   function getCheckoutButton() {
//     const selectors = [
//       '#checkout-customer-btn',
//       'button[name="checkout"]',
//       '#checkout',
//       '.btn-checkout',
//       '.cart__checkout-button',
//       '.checkout-button',
//       '.checkout-btn',
//       '[data-checkout-button]',
//       'form[action="/cart"] [type="submit"]'
//     ];
//     for (let s of selectors) {
//       const el = document.querySelector(s);
//       if (el) return el;
//     }
//     return null;
//   }

//   function showSlotError(message) {
//     console.warn('❌ Showing Error Banner:', message);
//     let banner = document.getElementById('bk-cart-error');
//     if (!banner) {
//       banner = document.createElement('div');
//       banner.id = 'bk-cart-error';
//       banner.style.cssText = `background: #FFF0EE; color: #B42318; border: 1px solid #F5C6C2; padding: 15px; margin: 20px 0; font-family: sans-serif; font-weight: 600; font-size: 14px; text-align: center; z-index: 9999; position: relative;`;
//       const cartContainer = document.querySelector('.cart-container, #main-cart, .cart__wrapper, .cart-drawer') || document.body;
//       cartContainer.prepend(banner);
//     }
//     banner.textContent = '⚠️ ' + message;
//     banner.style.display = 'block';
//   }

//   function lockCheckout(originalText) {
//     const btn = getCheckoutButton();
//     if (btn) {
//       console.log('🔒 Locking Checkout Button');
//       btn.disabled = true;
//       btn.style.opacity = '0.5';
//       btn.style.pointerEvents = 'none';
//       btn.textContent = 'Slot Unavailable';
//       btn.dataset.originalText = originalText || btn.textContent;
//     }
//   }

//   // ============================================================
//   // 3. CORE VALIDATION LOGIC
//   // ============================================================
//   async function validateCart() {
//     console.log('🔍 Validating Cart Availability...');
//     try {
//       const response = await fetch('/cart.js');
//       const cart = await response.json();

//       const bookingItems = [];
//       cart.items.forEach(item => {
//         let dateProp = null;
//         let slotProp = null;
//         if (item.properties) {
//           if (Array.isArray(item.properties)) {
//             dateProp = item.properties.find(p => p.name && p.name.toLowerCase().includes('date'))?.value;
//             slotProp = item.properties.find(p => p.name && p.name.toLowerCase().includes('slot'))?.value;
//           } else if (typeof item.properties === 'object') {
//             const keys = Object.keys(item.properties);
//             const dateKey = keys.find(k => k.toLowerCase().includes('date'));
//             const slotKey = keys.find(k => k.toLowerCase().includes('slot'));
//             if (dateKey) dateProp = item.properties[dateKey];
//             if (slotKey) slotProp = item.properties[slotKey];
//           }
//         }
//         if (dateProp && slotProp) {
//           bookingItems.push({ date: dateProp, slot: slotProp });
//         }
//       });

//       if (bookingItems.length === 0) {
//         console.log('ℹ️ No booking items found in cart.');
//         return;
//       }

//       for (const item of bookingItems) {
//         const d = new Date(item.date);
//         let dateStr = item.date;
//         if (!isNaN(d.getTime())) {
//           const year = d.getFullYear();
//           const month = String(d.getMonth() + 1).padStart(2, '0');
//           const day = String(d.getDate()).padStart(2, '0');
//           dateStr = `${year}-${month}-${day}`;
//         }

//         let slotKey = 'morning';
//         if (item.slot.toLowerCase().includes('evening') || item.slot.toLowerCase().includes('pm')) {
//           slotKey = 'evening';
//         }

//         console.log(`📡 Querying Supabase: DATE[${dateStr}] | SLOT[${slotKey}]`);

//         const { data, error, count } = await sb
//           .from('bookings')
//           .select('id', { count: 'exact' })
//           .eq('booking_date', dateStr)
//           .eq('slot', slotKey)
//           .eq('is_active', true);

//         if (error) {
//           console.error('❌ Supabase Error:', error);
//           const btn = getCheckoutButton();
//           lockCheckout(btn?.textContent);
//           showSlotError(`System Error: Unable to verify slot availability.`);
//           return;
//         }

//         if (count >= MAX_BOOKINGS_PER_SLOT) {
//           console.warn(`🚨 SLOT FULL: ${dateStr} ${slotKey} has ${count} bookings.`);
//           const btn = getCheckoutButton();
//           lockCheckout(btn?.textContent);
//           showSlotError(`The delivery slot for ${item.date} is no longer available.`);
//           return;
//         }
//       }
//       console.log('✅ All slots in cart are currently available.');
//     } catch (err) {
//       console.error('💥 Critical Cart Guard Error:', err);
//     }
//   }

//   // ============================================================
//   // 4. AUTOMATION & OBSERVERS
//   // ============================================================
//   const observer = new MutationObserver(() => {
//     if (getCheckoutButton()) {
//       validateCart();
//     }
//   });

//   observer.observe(document.body, {
//     childList: true,
//     subtree: true
//   });

//   validateCart();

//   document.addEventListener('cart:update', validateCart);
//   document.addEventListener('cart:change', validateCart);
//   document.addEventListener('shopify:cart:updated', validateCart);

// })();










// UPPER CODE GOOD







/**
 * LILY SERVICE - Cart Availability Guard (Optimized)
 * Fixed infinite loop and unnecessary querying.
 */
/**
 * LILY SERVICE - Cart Availability Guard (REAL-TIME AUTOMATION)
 * Listens to Supabase Realtime events to block checkout instantly.
 */

(async function () {
  'use strict';

  console.log('🚀 Lily Cart Guard: Real-Time Automation Active...');

  const CONFIG = {
    supabaseUrl: "https://adcjzrstjrdxzfobcfbl.supabase.co",
    supabaseKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFkY2p6cnN0anJkeHpmb2JjZmJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxOTY0MDYsImV4cCI6MjA5Mjc3MjQwNn0.vDPAwlOAr9OaGHU-unHI3l3_guja_wLjhCAivZ8nscA",
    maxCapacity: 2,
  };

  const sb = supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);

  function getCheckoutButton() {
    const selectors = ['#checkout-customer-btn', 'button[name="checkout"]', '#checkout', '.btn-checkout', '.cart__checkout-button', '.checkout-button', '.checkout-btn', '[data-checkout-button]', 'form[action="/cart"] [type="submit"]'];
    for (let s of selectors) {
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
    banner.textContent = '⚠️ ' + message;
    banner.style.display = 'block';
  }

  function lockCheckout(originalText) {
    const btn = getCheckoutButton();
    if (btn) {
      console.log('🔒 LOCKING CHECKOUT: Slot taken by another user.');
      btn.disabled = true;
      btn.style.opacity = '0.5';
      btn.style.pointerEvents = 'none';
      btn.textContent = 'Slot Unavailable';
      btn.dataset.originalText = originalText || btn.textContent;
    }
  }

  function unlockCheckout() {
    const btn = getCheckoutButton();
    if (btn && btn.dataset.originalText) {
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
      btn.textContent = btn.dataset.originalText;
    }
  }

  async function validateCart() {
    console.log('🔍 Real-time Validation Running...');
    try {
      const response = await fetch('/cart.js');
      const cart = await response.json();
      const bookingItems = [];

      cart.items.forEach(item => {
        let dateProp = null, slotProp = null;
        if (item.properties) {
          if (Array.isArray(item.properties)) {
            dateProp = item.properties.find(p => p.name && p.name.toLowerCase().includes('date'))?.value;
            slotProp = item.properties.find(p => p.name && p.name.toLowerCase().includes('slot'))?.value;
          } else if (typeof item.properties === 'object') {
            const keys = Object.keys(item.properties);
            const dK = keys.find(k => k.toLowerCase().includes('date'));
            const sK = keys.find(k => k.toLowerCase().includes('slot'));
            if (dK) dateProp = item.properties[dK];
            if (sK) slotProp = item.properties[sK];
          }
        }
        if (dateProp && slotProp) bookingItems.push({ date: dateProp, slot: slotProp });
      });

      if (bookingItems.length === 0) return;

      for (const item of bookingItems) {
        const d = new Date(item.date);
        let dateStr = item.date;
        if (!isNaN(d.getTime())) {
          dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        }
        let slotKey = item.slot.toLowerCase().includes('evening') || item.slot.toLowerCase().includes('pm') ? 'evening' : 'morning';

        const { data, error, count } = await sb
          .from('bookings')
          .select('id', { count: 'exact' })
          .eq('booking_date', dateStr)
          .eq('slot', slotKey)
          .eq('is_active', true);

        if (error) return;

        if (count >= CONFIG.maxCapacity) {
          lockCheckout();
          showSlotError(`The delivery slot for ${item.date} is no longer available.`);
          return;
        }
      }
      unlockCheckout();
      const banner = document.getElementById('bk-cart-error');
      if (banner) banner.style.display = 'none';
    } catch (err) {
      console.error('Cart Guard Error:', err);
    }
  }

  // ============================================================
  // THE AUTOMATION ENGINE (Supabase Realtime)
  // ============================================================

  // This listens for ANY change in the bookings table (Insert, Update, Delete)
  // AND the blocked_slots table — so the instant another tab places an order,
  // this tab re-validates and locks/unlocks checkout within milliseconds.
  let rtChannel = null;
  try {
    rtChannel = sb.channel('cart-guard-live-' + Math.random().toString(36).slice(2, 8))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, (payload) => {
        console.log('📡 REAL-TIME NOTIFICATION: Booking table changed!', payload);
        validateCart();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'blocked_slots' }, (payload) => {
        console.log('📡 REAL-TIME NOTIFICATION: Blocked slots changed!', payload);
        validateCart();
      })
      .subscribe();
  } catch (e) {
    console.error('Realtime subscription failed:', e);
  }

  // 1. Wake-up: Run validation when user switches back to the tab
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') validateCart();
  });

  // 2. DOM Observer: Handle AJAX carts
  const observer = new MutationObserver(() => {
    if (getCheckoutButton()) validateCart();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // 3. Initial Run
  validateCart();

  // 4. Standard AJAX event listeners
  document.addEventListener('cart:update', validateCart);
  document.addEventListener('cart:change', validateCart);
  document.addEventListener('shopify:cart:updated', validateCart);

})();
