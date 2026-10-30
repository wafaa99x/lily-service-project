/**
 * LILY SERVICE - Delivery Fee (AJAX only, no page reloads)
 *
 * - The customer picks a governorate + area in the cart summary.
 * - Exactly ONE delivery fee product (3 / 5 / 7 / 10 KWD) is kept in the cart, quantity 1.
 * - The chosen area is saved on the cart as attributes "Delivery Governorate" and
 *   "Delivery Area", so it survives reloads and shows on the order in Shopify admin.
 * - The dropdowns always reflect the cart: no fee in the cart = "Select".
 * - If the cart has no real products left, the fee AND the saved area are cleared.
 *
 * Areas and prices live in ONE place: window.LilyCartRules (assets/cart-v.js),
 * which loads before this file.
 */
(function () {
  'use strict';
  if (window.__lilyDeliveryFee) return;
  window.__lilyDeliveryFee = true;

  var R = window.LilyCartRules;
  if (!R || !R.DELIVERY_DATA) {
    console.error('[delivery-fee] LilyCartRules missing: assets/cart-v.js must load first.');
    return;
  }

  var DELIVERY_VARIANTS = R.DELIVERY_VARIANTS;
  var DELIVERY_DATA = R.DELIVERY_DATA;
  var DELIVERY_IDS = Object.keys(DELIVERY_VARIANTS).map(function (k) { return String(DELIVERY_VARIANTS[k]); });

  var SOURCE = 'delivery-fee';
  var ATTR_GOV = R.ATTR_GOV;
  var ATTR_AREA = R.ATTR_AREA;
  var ROOT = R.ROOT;

  // ======================
  // STATE
  // ======================
  var state = { gov: '', area: '' }; // what the dropdowns should show
  var lastServer = null;             // last delivery state rendered by the server
  var busy = false;
  var statusMsg = '';
  var latestSelection = 0;
  var queue = Promise.resolve(); // all cart writes run one at a time, in order

  function isDelivery(item) { return DELIVERY_IDS.indexOf(String(item.variant_id)) !== -1; }
  function feeFor(gov, area) { return (gov && area && DELIVERY_DATA[gov] && DELIVERY_DATA[gov][area]) || null; }
  function variantFor(gov, area) { var f = feeFor(gov, area); return f ? DELIVERY_VARIANTS[f] : null; }

  function enqueue(task) {
    var run = queue.then(task, task);
    queue = run.catch(function () {});
    return run;
  }

  function readLocal(key) { try { return localStorage.getItem(key) || ''; } catch (e) { return ''; } }
  function saveLocal(gov, area) {
    try {
      localStorage.setItem('selectedGov', gov);
      localStorage.setItem('selectedArea', area);
      localStorage.setItem('selected_delivery_area', area);
    } catch (e) {}
  }
  function clearLocal() {
    try {
      localStorage.removeItem('selectedGov');
      localStorage.removeItem('selectedArea');
      localStorage.removeItem('selected_delivery_area');
    } catch (e) {}
  }

  function clearedAttrs() {
    var a = {};
    a[ATTR_GOV] = '';
    a[ATTR_AREA] = '';
    return a;
  }

  // ======================
  // CART API (AJAX)
  // ======================
  function sectionIds() {
    var ids = [];
    document.querySelectorAll('cart-items-component[data-section-id]').forEach(function (el) {
      if (ids.indexOf(el.dataset.sectionId) === -1) ids.push(el.dataset.sectionId);
    });
    return ids;
  }

  function getCart() {
    return fetch(ROOT + 'cart.js', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.json(); });
  }

  function postUpdate(payload) {
    var body = Object.assign({}, payload);
    var ids = sectionIds();
    if (ids.length) {
      body.sections = ids.join(',');
      body.sections_url = window.location.pathname;
    }
    return fetch(ROOT + 'cart/update.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok || data.status || data.errors) {
          throw new Error(data.description || data.message || 'Cart update failed');
        }
        return data;
      });
    });
  }

  function expectedKey(cart) {
    var attrs = cart.attributes || {};
    return (attrs[ATTR_GOV] || '') + '|' + (attrs[ATTR_AREA] || '');
  }

  function renderedKey() {
    var box = document.getElementById('delivery-box');
    if (!box) return null;
    return (box.dataset.selectedGov || '') + '|' + (box.dataset.selectedArea || '');
  }

  // Fallback: if the theme did not re-render the cart, replace the section HTML ourselves
  function forceRender() {
    var ids = sectionIds();
    if (!ids.length) return Promise.resolve();
    var url = window.location.pathname + '?sections=' + encodeURIComponent(ids.join(','));
    return fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (sections) {
        ids.forEach(function (id) {
          var html = sections && sections[id];
          var current = document.getElementById('shopify-section-' + id);
          if (!html || !current) return;
          var doc = new DOMParser().parseFromString(html, 'text/html');
          var fresh = doc.getElementById('shopify-section-' + id);
          if (fresh) current.innerHTML = fresh.innerHTML;
        });
        lastServer = null;
        scheduleSync();
      })
      .catch(function () {});
  }

  // Tell the theme the cart changed (it re-renders without a reload), then verify
  function notify(cart) {
    document.dispatchEvent(new CustomEvent('cart:update', {
      bubbles: true,
      detail: {
        resource: cart,
        sourceId: SOURCE,
        data: { source: SOURCE, itemCount: cart.item_count, sections: cart.sections || undefined }
      }
    }));
    var want = expectedKey(cart);
    setTimeout(function () {
      var have = renderedKey();
      if (have !== null && have !== want) forceRender();
    }, 600);
  }

  // Keep exactly one fee line (target variant, qty 1); target = null removes every fee line
  function buildUpdates(cart, target) {
    var updates = {};
    var kept = false;
    cart.items.forEach(function (i) {
      if (!isDelivery(i)) return;
      if (target && !kept && String(i.variant_id) === target) {
        kept = true;
        if (i.quantity !== 1) updates[i.key] = 1;
      } else {
        updates[i.key] = 0;
      }
    });
    if (target && !kept) updates[target] = 1;
    return updates;
  }

  function sameAttrs(cart, attributes) {
    if (!attributes) return true;
    var cur = cart.attributes || {};
    return Object.keys(attributes).every(function (k) { return (cur[k] || '') === (attributes[k] || ''); });
  }

  function writeDelivery(cart, target, attributes) {
    var updates = buildUpdates(cart, target);
    if (!Object.keys(updates).length && sameAttrs(cart, attributes)) return Promise.resolve(null);

    var payload = { updates: updates };
    if (attributes) payload.attributes = attributes;

    return postUpdate(payload).catch(function () {
      var simple = {};
      cart.items.forEach(function (i) { if (isDelivery(i)) simple[i.variant_id] = 0; });
      if (target) simple[target] = 1;
      payload.updates = simple;
      return postUpdate(payload);
    }).then(function (newCart) {
      notify(newCart);
      return newCart;
    });
  }

  // ======================
  // CUSTOMER PICKS AN AREA
  // ======================
  function applySelection(gov, area) {
    var variantId = variantFor(gov, area);
    if (!variantId) return;
    var ticket = ++latestSelection;
    var doneMsg = '';
    saveLocal(gov, area);
    setBusy(true, 'Updating delivery fee…');

    enqueue(function () {
      if (ticket !== latestSelection) return;
      return getCart().then(function (cart) {
        var realCount = cart.items.filter(function (i) { return !isDelivery(i); }).length;
        if (!realCount) { doneMsg = 'Add a product to your cart first.'; return; }
        var attrs = {};
        attrs[ATTR_GOV] = gov;
        attrs[ATTR_AREA] = area;
        return writeDelivery(cart, String(variantId), attrs);
      });
    }).then(function () {
      if (ticket === latestSelection) setBusy(false, doneMsg);
    }).catch(function (err) {
      console.error('Delivery fee update failed:', err);
      if (ticket === latestSelection) setBusy(false, 'Could not update the delivery fee. Please try again.');
    });
  }

  // ======================
  // AUTO-FIX THE CART (on load and after any other cart change)
  // ======================
  function reconcile() {
    return enqueue(function () {
      return getCart().then(function (cart) {
        var lines = cart.items.filter(isDelivery);
        var realCount = cart.items.length - lines.length;
        var attrs = cart.attributes || {};
        var hasAttrs = !!(attrs[ATTR_GOV] || attrs[ATTR_AREA]);

        if (!realCount) {
          if (lines.length || hasAttrs) {
            clearLocal();
            state.gov = '';
            state.area = '';
            return writeDelivery(cart, null, hasAttrs ? clearedAttrs() : null);
          }
          return null;
        }

        if (!lines.length) {
          if (hasAttrs) {
            clearLocal();
            state.gov = '';
            state.area = '';
            return writeDelivery(cart, null, clearedAttrs());
          }
          return null;
        }

        var target = variantFor(attrs[ATTR_GOV], attrs[ATTR_AREA]);
        var newAttrs = null;

        if (!target) {
          var lg = readLocal('selectedGov');
          var la = readLocal('selectedArea');
          if (variantFor(lg, la)) {
            target = variantFor(lg, la);
            newAttrs = {};
            newAttrs[ATTR_GOV] = lg;
            newAttrs[ATTR_AREA] = la;
          } else {
            return writeDelivery(cart, null, hasAttrs ? clearedAttrs() : null);
          }
        }

        return writeDelivery(cart, String(target), newAttrs);
      });
    }).catch(function (err) {
      console.error('Delivery fee check failed:', err);
    });
  }

  // ======================
  // UI
  // ======================
  function populateAreas(areaEl, gov) {
    var areas = gov && DELIVERY_DATA[gov] ? Object.keys(DELIVERY_DATA[gov]) : [];
    if (areaEl.getAttribute('data-gov') === (gov || '') && areaEl.options.length === areas.length + 1) return;
    areaEl.innerHTML = '';
    areaEl.add(new Option('Select Area', ''));
    areas.forEach(function (a) {
      areaEl.add(new Option(a + ' - ' + DELIVERY_DATA[gov][a] + ' KWD', a));
    });
    areaEl.setAttribute('data-gov', gov || '');
  }

  function restoreCheckoutButton() {
    var btn = document.getElementById('checkout-customer-btn');
    if (!btn) return;
    btn.disabled = btn.dataset.deliveryReady === 'false' || !!btn.dataset.originalText;
  }

  function syncUI() {
    var box = document.getElementById('delivery-box');
    if (!box) return;
    var govEl = box.querySelector('#gov');
    var areaEl = box.querySelector('#area');
    if (!govEl || !areaEl) return;

    if (govEl.getAttribute('autocomplete') !== 'off') govEl.setAttribute('autocomplete', 'off');
    if (areaEl.getAttribute('autocomplete') !== 'off') areaEl.setAttribute('autocomplete', 'off');

    var server = (box.dataset.selectedGov || '') + '|' + (box.dataset.selectedArea || '');
    if (server !== lastServer) {
      lastServer = server;
      if (!busy) {
        state.gov = box.dataset.selectedGov || '';
        state.area = box.dataset.selectedArea || '';
      }
    }

    if (govEl.value !== state.gov) govEl.value = state.gov;
    populateAreas(areaEl, state.gov);
    if (areaEl.value !== state.area) areaEl.value = state.area;

    if (govEl.disabled !== busy) govEl.disabled = busy;
    if (areaEl.disabled !== busy) areaEl.disabled = busy;
    if (box.classList.contains('is-busy') !== busy) box.classList.toggle('is-busy', busy);

    var statusEl = box.querySelector('.delivery-status');
    if (statusEl && statusEl.textContent !== statusMsg) statusEl.textContent = statusMsg;

    var btn = document.getElementById('checkout-customer-btn');
    if (btn && busy && !btn.disabled) btn.disabled = true;
  }

  var syncScheduled = false;
  function scheduleSync() {
    if (syncScheduled) return;
    syncScheduled = true;
    requestAnimationFrame(function () {
      syncScheduled = false;
      syncUI();
    });
  }

  function setBusy(on, msg) {
    busy = on;
    statusMsg = msg || '';
    if (!on) restoreCheckoutButton();
    syncUI();
  }

  // ======================
  // EVENTS
  // ======================
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.closest || !t.closest('#delivery-box')) return;

    if (t.id === 'gov') {
      state.gov = t.value;
      state.area = '';
      statusMsg = t.value ? 'Now choose your area.' : '';
      syncUI();
    } else if (t.id === 'area') {
      state.area = t.value;
      if (t.value) applySelection(state.gov, t.value);
    }
  });

  // Checkout button (capture phase, so it also works after the cart re-renders)
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('#checkout-customer-btn') : null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (btn.disabled || busy) return;

    btn.disabled = true;
    getCart().then(function (cart) {
      var attrs = cart.attributes || {};
      var hasFee = cart.items.some(isDelivery);
      var gov = attrs[ATTR_GOV];
      var area = attrs[ATTR_AREA];
      if (!hasFee || !variantFor(gov, area)) {
        statusMsg = 'Please select your delivery area first.';
        restoreCheckoutButton();
        syncUI();
        var g = document.getElementById('gov');
        if (g) g.focus();
        return;
      }
      saveLocal(gov, area);
      window.location.href = ROOT + 'pages/customer-info';
    }).catch(function () {
      restoreCheckoutButton();
    });
  }, true);

  document.addEventListener('cart:update', function (e) {
    var src = e.detail && e.detail.data && e.detail.data.source;
    if (src !== SOURCE) reconcile();
    scheduleSync();
  });

  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) { syncUI(); return; }
    lastServer = null;
    forceRender();
    reconcile();
  });

  window.addEventListener('load', function () { syncUI(); });

  function start() {
    syncUI();
    if (document.querySelector('cart-items-component') || document.getElementById('delivery-box')) {
      reconcile();
    }
    new MutationObserver(scheduleSync).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
