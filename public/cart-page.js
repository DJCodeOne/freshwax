// Cart page logic - uses FreshWaxCart system

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
  } catch (e) {
    console.error('[Cart] Error parsing cart:', e);
  }
  
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

function updateCartCount() {
  var cart = getCart();
  var items = cart.items || [];
  var totalItems = items.reduce(function(sum, item) { return sum + (item.quantity || 1); }, 0);
  
  var cartCountDesktop = document.getElementById('cart-count');
  var cartCountMobile = document.getElementById('cart-count-mobile');
  
  [cartCountDesktop, cartCountMobile].forEach(function(el) {
    if (el) {
      if (totalItems > 0) {
        el.textContent = totalItems.toString();
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    }
  });
  
  // Also update data-cart-count elements
  document.querySelectorAll('[data-cart-count]').forEach(function(el) {
    el.textContent = totalItems;
    el.style.display = totalItems > 0 ? '' : 'none';
  });
}

function calculateTotals(items) {
  var subtotal = items.reduce(function(sum, item) { return sum + ((item.price || 0) * (item.quantity || 1)); }, 0);
  var hasPhysicalItems = items.some(function(item) {
    return item.type === 'vinyl' || item.type === 'merch' || 
           item.format === 'vinyl' || item.format === 'merch';
  });
  var shipping = hasPhysicalItems && subtotal > 0 ? (subtotal >= 50 ? 0 : 4.99) : 0;
  var total = subtotal + shipping;
  return { subtotal: subtotal, shipping: shipping, total: total, hasPhysicalItems: hasPhysicalItems };
}

function getBadgeStyle(type) {
  if (type === 'vinyl') return 'background: #000; color: #fff; border-color: #fff;';
  if (type === 'merch') return 'background: #1e1b4b; color: #a5b4fc; border-color: #a5b4fc;';
  if (type === 'track') return 'background: #1e3a5f; color: #7dd3fc; border-color: #7dd3fc;';
  return 'background: #052e16; color: #22c55e; border-color: #22c55e;';
}

function updateQuantity(index, newQuantity) {
  var cart = getCart();
  var items = cart.items || [];
  
  if (!newQuantity || newQuantity < 1) {
    items[index].quantity = 1;
  } else if (newQuantity > 10) {
    items[index].quantity = 10;
  } else {
    items[index].quantity = newQuantity;
  }
  
  saveCart({ items: items });
  renderCart();
}

function removeItem(index) {
  var cart = getCart();
  var items = cart.items || [];
  items.splice(index, 1);
  saveCart({ items: items });
  renderCart();
}

function renderCart() {
  var container = document.getElementById('cart-content');
  if (!container) {
    // Not on cart page, skip silently
    return;
  }
  
  var customerId = getCustomerId();
  var cartKey = getCartKey();
  var rawData = cartKey ? localStorage.getItem(cartKey) : null;
  
  console.log('[Cart Page] Debug:');
  console.log('  Customer ID:', customerId);
  console.log('  Cart key:', cartKey);
  console.log('  Raw localStorage:', rawData);
  
  // Check if logged in
  if (!customerId) {
    container.innerHTML = 
      '<div style="background: #000; border: 3px solid #fff; border-radius: 12px; overflow: hidden;">' +
        '<div style="padding: 1rem 1.25rem; background: #111; border-bottom: 2px solid #333;">' +
          '<h2 style="font-family: Bebas Neue, sans-serif; font-size: 1.5rem; font-weight: 400; letter-spacing: 0.04em; color: #fff; margin: 0;">YOUR BAG</h2>' +
        '</div>' +
        '<div style="text-align: center; padding: 4rem 2rem;">' +
          '<div style="font-size: 5rem; margin-bottom: 1.5rem;">🔐</div>' +
          '<h3 style="margin: 0 0 1rem 0; font-family: Bebas Neue, sans-serif; font-size: 2rem; font-weight: 400; color: #fff; letter-spacing: 0.02em;">LOGIN REQUIRED</h3>' +
          '<p style="margin: 0 0 2rem 0; color: #888; font-size: 1.125rem;">Please log in to view your bag</p>' +
          '<a href="/login?redirect=/cart" style="display: inline-block; padding: 1rem 2.5rem; background: #dc2626; color: #fff; text-decoration: none; font-weight: 700; font-size: 1.125rem; border-radius: 10px; text-transform: uppercase; letter-spacing: 0.04em;">Login</a>' +
        '</div>' +
      '</div>';
    return;
  }
  
  var cart = getCart();
  var items = cart.items || [];
  console.log('[Cart] Items:', items);
  
  if (items.length === 0) {
    container.innerHTML = 
      '<div style="background: #000; border: 3px solid #fff; border-radius: 12px; overflow: hidden;">' +
        '<div style="padding: 1rem 1.25rem; background: #111; border-bottom: 2px solid #333;">' +
          '<h2 style="font-family: Bebas Neue, sans-serif; font-size: 1.5rem; font-weight: 400; letter-spacing: 0.04em; color: #fff; margin: 0;">YOUR BAG</h2>' +
        '</div>' +
        '<div style="text-align: center; padding: 4rem 2rem;">' +
          '<div style="font-size: 5rem; margin-bottom: 1.5rem; filter: grayscale(1);">🎵</div>' +
          '<h3 style="margin: 0 0 1rem 0; font-family: Bebas Neue, sans-serif; font-size: 2.5rem; font-weight: 400; color: #dc2626; letter-spacing: 0.02em;">YOUR BAG IS EMPTY</h3>' +
          '<p style="margin: 0 0 2rem 0; color: #888; font-size: 1.125rem;">Time to dig for some fresh wax</p>' +
          '<a href="/" style="display: inline-block; padding: 1rem 2.5rem; background: #fff; color: #000; text-decoration: none; font-weight: 700; font-size: 1.125rem; border-radius: 10px; text-transform: uppercase; letter-spacing: 0.04em;">Browse Releases</a>' +
        '</div>' +
      '</div>';
    return;
  }
  
  var totals = calculateTotals(items);
  var subtotal = totals.subtotal;
  var shipping = totals.shipping;
  var total = totals.total;
  var hasPhysicalItems = totals.hasPhysicalItems;
  var itemCount = items.reduce(function(sum, item) { return sum + (item.quantity || 1); }, 0);
  
  var itemsHTML = '';
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var itemType = item.type || item.format || 'digital';
    var quantity = item.quantity || 1;
    var price = item.price || 0;
    var priceTotal = (price * quantity).toFixed(2);
    var priceEach = price.toFixed(2);
    var itemName = item.name || item.title || 'Unknown Item';
    var itemImage = item.image || item.artwork || '/logo.webp';
    
    itemsHTML += 
      '<article style="display: grid; grid-template-columns: 100px 1fr; gap: 1.25rem; padding: 1.25rem; background: #000; border: 3px solid #fff; border-radius: 12px;">' +
        '<div style="width: 100px; height: 100px; border-radius: 8px; overflow: hidden; background: #111; border: 2px solid #fff; flex-shrink: 0;">' +
          '<img src="' + itemImage + '" alt="' + itemName + '" style="width: 100px; height: 100px; object-fit: cover; display: block;" onerror="this.src=\'/logo.webp\'">' +
        '</div>' +
        '<div style="display: flex; flex-direction: column; min-width: 0;">' +
          '<div style="margin-bottom: 0.625rem;">' +
            '<h3 style="margin: 0 0 0.375rem 0; font-size: 1.25rem; font-weight: 700; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">' + itemName + '</h3>' +
            '<div style="display: flex; gap: 0.625rem; flex-wrap: wrap; align-items: center;">' +
              '<span style="display: inline-block; padding: 0.2rem 0.625rem; font-size: 0.875rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; border-radius: 5px; border: 2px solid; ' + getBadgeStyle(itemType) + '">' + itemType + '</span>' +
              (item.color ? '<span style="font-size: 0.95rem; color: #a0a0a0;">' + (typeof item.color === 'object' ? item.color.name : item.color) + '</span>' : '') +
              (item.size ? '<span style="font-size: 0.95rem; color: #a0a0a0;">Size: ' + item.size + '</span>' : '') +
            '</div>' +
          '</div>' +
          '<div style="display: flex; justify-content: space-between; align-items: flex-end; margin-top: auto; flex-wrap: wrap; gap: 1rem;">' +
            '<div style="display: flex; align-items: center; gap: 0.5rem;">' +
              '<button onclick="updateQuantity(' + i + ', ' + (quantity - 1) + ')" style="width: 36px; height: 36px; background: #000; border: 2px solid #fff; border-radius: 8px; color: #fff; font-size: 1.25rem; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center;"' + (quantity <= 1 ? ' disabled' : '') + '>−</button>' +
              '<span style="min-width: 40px; text-align: center; font-size: 1.125rem; font-weight: 700; color: #fff;">' + quantity + '</span>' +
              '<button onclick="updateQuantity(' + i + ', ' + (quantity + 1) + ')" style="width: 36px; height: 36px; background: #000; border: 2px solid #fff; border-radius: 8px; color: #fff; font-size: 1.25rem; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center;"' + (quantity >= 10 ? ' disabled' : '') + '>+</button>' +
              '<button onclick="removeItem(' + i + ')" style="margin-left: 0.5rem; padding: 0.5rem 1rem; background: transparent; border: 2px solid #dc2626; border-radius: 8px; color: #dc2626; font-size: 0.875rem; font-weight: 600; cursor: pointer;">Remove</button>' +
            '</div>' +
            '<div style="text-align: right;">' +
              '<div style="font-size: 1.375rem; font-weight: 700; color: #fff;">£' + priceTotal + '</div>' +
              (quantity > 1 ? '<div style="font-size: 0.875rem; color: #888;">£' + priceEach + ' each</div>' : '') +
            '</div>' +
          '</div>' +
        '</div>' +
      '</article>';
  }
  
  var shippingText = hasPhysicalItems ? (shipping === 0 ? 'FREE' : '£' + shipping.toFixed(2)) : 'Digital delivery';
  var shippingColor = !hasPhysicalItems || shipping === 0 ? '#22c55e' : '#fff';
  
  var freeShippingHint = '';
  if (hasPhysicalItems && shipping > 0 && subtotal < 50) {
    freeShippingHint = 
      '<div style="padding: 0.875rem 1rem; background: #111; border: 2px solid #333; border-radius: 8px; text-align: center;">' +
        '<span style="font-size: 0.9375rem; color: #888;">🚚 Add <strong style="color: #fff;">£' + (50 - subtotal).toFixed(2) + '</strong> more for free shipping</span>' +
      '</div>';
  } else if (hasPhysicalItems && shipping === 0 && subtotal >= 50) {
    freeShippingHint = 
      '<div style="padding: 0.875rem 1rem; background: #052e16; border: 2px solid #22c55e; border-radius: 8px; text-align: center;">' +
        '<span style="font-size: 0.9375rem; color: #22c55e;">✓ Free shipping on orders over £50!</span>' +
      '</div>';
  }
  
  container.innerHTML = 
    '<div style="background: #000; border: 3px solid #fff; border-radius: 12px; margin-bottom: 1.5rem; overflow: hidden;">' +
      '<div style="display: flex; align-items: center; justify-content: space-between; padding: 1rem 1.25rem; background: #111; border-bottom: 2px solid #333;">' +
        '<h2 style="font-family: Bebas Neue, sans-serif; font-size: 1.5rem; font-weight: 400; letter-spacing: 0.04em; color: #fff; margin: 0;">YOUR BAG</h2>' +
        '<span style="font-size: 0.9375rem; color: #888; font-weight: 500;">' + itemCount + ' ' + (itemCount === 1 ? 'item' : 'items') + '</span>' +
      '</div>' +
      '<div style="padding: 1.25rem;">' +
        '<div style="display: flex; flex-direction: column; gap: 1rem;">' + itemsHTML + '</div>' +
      '</div>' +
    '</div>' +
    '<div style="background: #000; border: 3px solid #fff; border-radius: 12px; overflow: hidden;">' +
      '<div style="padding: 1rem 1.25rem; background: #111; border-bottom: 2px solid #333;">' +
        '<h2 style="font-family: Bebas Neue, sans-serif; font-size: 1.5rem; font-weight: 400; letter-spacing: 0.04em; color: #fff; margin: 0;">ORDER SUMMARY</h2>' +
      '</div>' +
      '<div style="padding: 1.25rem;">' +
        '<div style="display: flex; flex-direction: column; gap: 1rem; margin-bottom: 1.5rem;">' +
          '<div style="display: flex; justify-content: space-between; align-items: center;">' +
            '<span style="font-size: 1rem; color: #888;">Subtotal</span>' +
            '<span style="font-size: 1.125rem; font-weight: 700; color: #fff;">£' + subtotal.toFixed(2) + '</span>' +
          '</div>' +
          '<div style="display: flex; justify-content: space-between; align-items: center;">' +
            '<span style="font-size: 1rem; color: #888;">Shipping</span>' +
            '<span style="font-size: 1.125rem; font-weight: 700; color: ' + shippingColor + ';">' + shippingText + '</span>' +
          '</div>' +
          freeShippingHint +
        '</div>' +
        '<div style="display: flex; justify-content: space-between; align-items: center; padding: 1.25rem; background: #111; border: 2px solid #fff; border-radius: 10px; margin-bottom: 1.5rem;">' +
          '<span style="font-family: Bebas Neue, sans-serif; font-size: 1.5rem; letter-spacing: 0.04em; color: #fff;">TOTAL</span>' +
          '<span style="font-size: 2rem; font-weight: 700; color: #fff;">£' + total.toFixed(2) + '</span>' +
        '</div>' +
        '<button onclick="goToCheckout()" style="width: 100%; padding: 1.25rem; background: #dc2626; color: #fff; border: none; border-radius: 12px; font-family: Bebas Neue, sans-serif; font-size: 1.5rem; font-weight: 400; letter-spacing: 0.08em; cursor: pointer;">' +
          'PROCEED TO CHECKOUT' +
        '</button>' +
        '<div style="display: flex; align-items: center; justify-content: center; gap: 0.5rem; margin-top: 1rem; font-size: 0.9375rem; color: #666;">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>' +
          '</svg>' +
          'Secure Checkout' +
        '</div>' +
      '</div>' +
    '</div>';
}

function goToCheckout() {
  window.location.href = '/checkout';
}

// Initialize
function init() {
  // Only run on cart page
  var container = document.getElementById('cart-content');
  if (!container) {
    // Not on cart page, skip
    return;
  }
  
  try {
    console.log('[Cart Page] Initializing...');
    updateCartCount();
    renderCart();
  } catch (err) {
    console.error('[Cart Page] Init error:', err);
    container.innerHTML = '<div style="color: red; padding: 2rem;">Error loading cart: ' + err.message + '</div>';
  }
}

// Listen for cart updates
window.addEventListener('cart-updated', function() {
  updateCartCount();
  renderCart();
});

window.addEventListener('cartUpdated', function() {
  updateCartCount();
  renderCart();
});

// Handle Astro page transitions
document.addEventListener('astro:page-load', function() {
  console.log('[Cart Page] Astro page-load event');
  init();
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}