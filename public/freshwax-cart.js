// public/freshwax-cart.js
// Cart functionality with Cloudflare KV persistence
// localStorage = fast cache, KV = reliable persistence

// ========== HELPERS ==========
function getCustomerId() {
  var cookies = document.cookie.split(';');
  for (var i = 0; i < cookies.length; i++) {
    var cookie = cookies[i].trim();
    var parts = cookie.split('=');
    if (parts[0] === 'customerId' && parts[1]) {
      return parts[1];
    }
  }
  return null;
}

function getCartKey() {
  var customerId = getCustomerId();
  if (!customerId) return null;
  return 'freshwax_cart_' + customerId;
}

// ========== LOCAL STORAGE (FAST CACHE) ==========
function getLocalCart() {
  var key = getCartKey();
  if (!key) return { items: [], updatedAt: null };

  try {
    var stored = localStorage.getItem(key);
    if (stored) {
      var data = JSON.parse(stored);
      return {
        items: data.items || [],
        updatedAt: data.updatedAt || null
      };
    }
  } catch (e) {
    console.error('[Cart] localStorage read error:', e);
  }

  return { items: [], updatedAt: null };
}

function saveLocalCart(cart) {
  var key = getCartKey();
  if (!key) return;

  var cartData = {
    items: cart.items || [],
    updatedAt: new Date().toISOString()
  };

  try {
    localStorage.setItem(key, JSON.stringify(cartData));
  } catch (e) {
    console.error('[Cart] localStorage write error:', e);
  }

  // Dispatch events for UI updates
  window.dispatchEvent(new CustomEvent('cart-updated', { detail: cartData }));
  window.dispatchEvent(new CustomEvent('cartUpdated', { detail: cartData }));
}

// ========== KV SYNC (RELIABLE PERSISTENCE) ==========
var kvSyncPending = false;
var kvSyncTimeout = null;

function syncToKV(cart) {
  // Debounce KV writes - wait 500ms after last change
  if (kvSyncTimeout) {
    clearTimeout(kvSyncTimeout);
  }

  kvSyncTimeout = setTimeout(function() {
    doKVSync(cart);
  }, 500);
}

function doKVSync(cart) {
  if (kvSyncPending) return;
  kvSyncPending = true;

  fetch('/api/cart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: cart.items || [] })
  })
  .then(function(res) { return res.json(); })
  .then(function(data) {
    if (data.success) {
      console.log('[Cart] Synced to KV:', (cart.items || []).length, 'items');
    } else {
      console.warn('[Cart] KV sync failed:', data.error);
    }
  })
  .catch(function(err) {
    console.warn('[Cart] KV sync error:', err);
  })
  .finally(function() {
    kvSyncPending = false;
  });
}

function loadFromKV() {
  return fetch('/api/cart')
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (data.success && data.cart) {
        console.log('[Cart] Loaded from KV:', (data.cart.items || []).length, 'items');
        return data.cart;
      }
      return null;
    })
    .catch(function(err) {
      console.warn('[Cart] KV load error:', err);
      return null;
    });
}

function clearKV() {
  fetch('/api/cart', { method: 'DELETE' })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      console.log('[Cart] KV cleared');
    })
    .catch(function(err) {
      console.warn('[Cart] KV clear error:', err);
    });
}

// ========== MAIN CART FUNCTIONS ==========
function getCart() {
  return getLocalCart();
}

function saveCart(cart) {
  saveLocalCart(cart);
  syncToKV(cart);
}

function addToCart(item) {
  console.log('[Cart] Adding item:', item.name, 'size:', item.size, 'color:', item.color);

  var customerId = getCustomerId();
  if (!customerId) {
    console.log('[Cart] No customer ID, redirecting to login');
    window.location.href = '/login?redirect=' + encodeURIComponent(window.location.pathname);
    return false;
  }

  var cart = getLocalCart();
  var items = cart.items || [];

  // Normalize size/color for comparison (treat undefined, null, '', 'none' as empty)
  function normalize(val) {
    if (!val || val === 'none' || val === 'null' || val === 'undefined') return '';
    return String(val).toLowerCase().trim();
  }

  var itemSize = normalize(item.size);
  var itemColor = normalize(item.color);

  // Check if exact variant exists (same id, type, size, color)
  var existingIndex = -1;
  for (var i = 0; i < items.length; i++) {
    var existing = items[i];
    var existingSize = normalize(existing.size);
    var existingColor = normalize(existing.color);

    if (existing.id === item.id &&
        existing.type === item.type &&
        existingSize === itemSize &&
        existingColor === itemColor) {
      existingIndex = i;
      break;
    }
  }

  if (existingIndex >= 0) {
    items[existingIndex].quantity += item.quantity || 1;
    console.log('[Cart] Updated quantity:', items[existingIndex].quantity);
  } else {
    var newItem = {};
    for (var key in item) {
      newItem[key] = item[key];
    }
    newItem.quantity = item.quantity || 1;
    items.push(newItem);
    console.log('[Cart] Added new variant, total items:', items.length);
  }

  saveCart({ items: items });
  updateCartBadge();
  return true;
}

function removeFromCart(itemId, size, color) {
  var cart = getLocalCart();
  var items = cart.items || [];

  items = items.filter(function(item) {
    if (item.id !== itemId) return true;
    if (size && item.size !== size) return true;
    if (color && item.color !== color) return true;
    return false;
  });

  saveCart({ items: items });
  updateCartBadge();
  return items;
}

function updateQuantity(itemId, quantity, size, color) {
  var cart = getLocalCart();
  var items = cart.items || [];

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (item.id === itemId) {
      if (size && item.size !== size) continue;
      if (color && item.color !== color) continue;

      if (quantity <= 0) {
        items.splice(i, 1);
      } else {
        item.quantity = quantity;
      }
      break;
    }
  }

  saveCart({ items: items });
  updateCartBadge();
  return items;
}

function getCartCount() {
  var cart = getLocalCart();
  var items = cart.items || [];
  var count = 0;
  for (var i = 0; i < items.length; i++) {
    count += items[i].quantity || 1;
  }
  return count;
}

function updateCartBadge() {
  var count = getCartCount();

  // Update all cart count elements
  var elements = document.querySelectorAll('[data-cart-count]');
  for (var i = 0; i < elements.length; i++) {
    elements[i].textContent = count;
    elements[i].style.display = count > 0 ? '' : 'none';
  }

  // Update header cart badges
  var desktopCount = document.getElementById('cart-count');
  var mobileCount = document.getElementById('cart-count-mobile');

  [desktopCount, mobileCount].forEach(function(el) {
    if (el) {
      el.textContent = count.toString();
      if (count > 0) {
        el.classList.remove('hidden', 'fwx-hidden');
        el.style.display = '';
      } else {
        el.classList.add('fwx-hidden');
        el.style.display = 'none';
      }
    }
  });
}

function clearCart() {
  var key = getCartKey();
  if (key) {
    localStorage.removeItem(key);
  }
  localStorage.removeItem('cart'); // Legacy

  clearKV();

  window.dispatchEvent(new CustomEvent('cart-updated', { detail: { items: [] } }));
  window.dispatchEvent(new CustomEvent('cartUpdated', { detail: { items: [] } }));

  updateCartBadge();
  return true;
}

// ========== INITIALIZATION ==========
var cartInitialized = false;

function initCart() {
  if (cartInitialized) return;
  cartInitialized = true;

  var customerId = getCustomerId();
  if (!customerId) {
    console.log('[Cart] No customer, skipping init');
    updateCartBadge();
    return;
  }

  console.log('[Cart] Initializing for customer:', customerId);

  // Load from localStorage first (instant)
  var localCart = getLocalCart();
  console.log('[Cart] Local cart:', localCart.items.length, 'items');

  // Then load from KV and merge if newer
  loadFromKV().then(function(kvCart) {
    if (!kvCart || !kvCart.items) {
      // No KV cart - sync local to KV if we have items
      if (localCart.items.length > 0) {
        console.log('[Cart] No KV cart, syncing local to KV');
        syncToKV(localCart);
      }
      return;
    }

    // Compare timestamps to determine which is newer
    var localTime = localCart.updatedAt ? new Date(localCart.updatedAt).getTime() : 0;
    var kvTime = kvCart.updatedAt ? new Date(kvCart.updatedAt).getTime() : 0;

    if (kvTime > localTime && kvCart.items.length > 0) {
      // KV is newer - update local
      console.log('[Cart] KV cart is newer, updating local');
      saveLocalCart(kvCart);
      updateCartBadge();
      window.dispatchEvent(new CustomEvent('cart-updated', { detail: kvCart }));
    } else if (localTime > kvTime && localCart.items.length > 0) {
      // Local is newer - sync to KV
      console.log('[Cart] Local cart is newer, syncing to KV');
      syncToKV(localCart);
    }
  });

  updateCartBadge();
}

// ========== EXPORTS ==========
window.FreshWaxCart = {
  add: addToCart,
  remove: removeFromCart,
  updateQty: updateQuantity,
  get: getCart,
  save: saveCart,
  count: getCartCount,
  updateBadge: updateCartBadge,
  clear: clearCart,
  init: initCart,
  loadFromKV: loadFromKV,
  isLoggedIn: function() { return !!getCustomerId(); },
  debug: function() {
    var cart = getLocalCart();
    console.log('[Cart Debug]');
    console.log('  Customer:', getCustomerId());
    console.log('  Items:', cart.items);
    console.log('  Count:', getCartCount());
    return cart;
  }
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', initCart);
document.addEventListener('astro:page-load', function() {
  console.log('[Cart] astro:page-load');
  cartInitialized = false; // Reset for new page
  initCart();
});
