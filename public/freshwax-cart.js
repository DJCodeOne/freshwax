// src/scripts/cart.js -> public/freshwax-cart.js
// Add to cart functionality - requires customer login

// ========== SESSION MANAGEMENT ==========
// Clear cart at start of each new browser session (but keep login)
(function() {
  var sessionKey = 'freshwax_session_active';
  
  if (!sessionStorage.getItem(sessionKey)) {
    console.log('[Session] New session detected - clearing cart only');
    
    // Clear all freshwax cart keys from localStorage
    var keysToRemove = [];
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (key && key.indexOf('freshwax_cart_') === 0) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(function(key) {
      localStorage.removeItem(key);
      console.log('[Session] Cleared cart:', key);
    });
    
    // Clear old 'cart' key too (legacy)
    localStorage.removeItem('cart');
    
    // Mark session as active
    sessionStorage.setItem(sessionKey, 'true');
  }
})();
// ========== END SESSION MANAGEMENT ==========

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

function getCart() {
  var key = getCartKey();
  if (!key) return { items: [] };
  
  try {
    var stored = localStorage.getItem(key);
    if (stored) {
      var data = JSON.parse(stored);
      return data.items ? data : { items: data };
    }
  } catch (e) {}
  
  return { items: [] };
}

function saveCart(cart) {
  var key = getCartKey();
  if (!key) return;
  
  var cartData = {
    items: cart.items || cart,
    updatedAt: new Date().toISOString()
  };
  localStorage.setItem(key, JSON.stringify(cartData));
  window.dispatchEvent(new CustomEvent('cart-updated', { detail: cartData }));
  window.dispatchEvent(new CustomEvent('cartUpdated', { detail: cartData }));
}

function addToCart(item) {
  var customerId = getCustomerId();
  
  if (!customerId) {
    window.location.href = '/login?redirect=' + encodeURIComponent(window.location.pathname);
    return false;
  }
  
  var cart = getCart();
  var items = cart.items || [];
  
  var existingIndex = -1;
  for (var i = 0; i < items.length; i++) {
    var existing = items[i];
    if (existing.id === item.id && 
        existing.type === item.type &&
        existing.format === item.format &&
        existing.size === item.size &&
        existing.color === item.color) {
      existingIndex = i;
      break;
    }
  }
  
  if (existingIndex >= 0) {
    items[existingIndex].quantity += item.quantity || 1;
  } else {
    var newItem = {};
    for (var key in item) {
      newItem[key] = item[key];
    }
    newItem.quantity = item.quantity || 1;
    items.push(newItem);
  }
  
  saveCart({ items: items });
  return true;
}

function getCartCount() {
  var cart = getCart();
  var items = cart.items || [];
  var count = 0;
  for (var i = 0; i < items.length; i++) {
    count += items[i].quantity || 1;
  }
  return count;
}

function updateCartBadge() {
  var count = getCartCount();
  var elements = document.querySelectorAll('[data-cart-count]');
  for (var i = 0; i < elements.length; i++) {
    elements[i].textContent = count;
    elements[i].style.display = count > 0 ? '' : 'none';
  }
  
  // Also update cart-count and cart-count-mobile
  var desktopCount = document.getElementById('cart-count');
  var mobileCount = document.getElementById('cart-count-mobile');
  
  [desktopCount, mobileCount].forEach(function(el) {
    if (el) {
      if (count > 0) {
        el.textContent = count.toString();
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    }
  });
}

function clearCart() {
  var key = getCartKey();
  if (key) {
    localStorage.removeItem(key);
    console.log('[Cart] Cleared:', key);
  }
  // Also clear legacy cart
  localStorage.removeItem('cart');
  
  // Dispatch events
  window.dispatchEvent(new CustomEvent('cart-updated', { detail: { items: [] } }));
  window.dispatchEvent(new CustomEvent('cartUpdated', { detail: { items: [] } }));
  
  updateCartBadge();
  return true;
}

function debugCart() {
  var customerId = getCustomerId();
  var key = getCartKey();
  var cart = getCart();
  console.log('[Cart Debug]');
  console.log('  Customer ID:', customerId);
  console.log('  Cart key:', key);
  console.log('  Items:', cart.items);
  console.log('  Count:', getCartCount());
  return cart;
}

window.FreshWaxCart = {
  add: addToCart,
  get: getCart,
  save: saveCart,
  count: getCartCount,
  updateBadge: updateCartBadge,
  clear: clearCart,
  debug: debugCart,
  isLoggedIn: function() { return !!getCustomerId(); }
};

document.addEventListener('DOMContentLoaded', updateCartBadge);