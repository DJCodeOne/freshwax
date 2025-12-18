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

function getBadgeStyle(type, isPreOrder) {
  if (isPreOrder) return 'background: linear-gradient(135deg, #f97316, #dc2626); color: #fff; border-color: #f97316;';
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
      '<div style="background: linear-gradient(to bottom, #1f2937 0%, #111827 100%); border: 2px solid rgba(255, 255, 255, 0.1); border-radius: 12px; overflow: hidden;">' +
        '<div style="padding: 1rem 1.25rem; background: linear-gradient(to right, #374151 0%, #1f2937 100%); border-bottom: 2px solid #dc2626;">' +
          '<h2 style="font-family: Inter, sans-serif; font-weight: 700; font-size: 1.5rem; font-weight: 400; letter-spacing: 0.04em; color: #fff; margin: 0;">YOUR BAG</h2>' +
        '</div>' +
        '<div style="text-align: center; padding: 4rem 2rem;">' +
          '<div style="font-size: 4rem; margin-bottom: 1.5rem;">🔐</div>' +
          '<h3 style="margin: 0 0 0.75rem 0; font-family: Inter, sans-serif; font-weight: 700; font-size: 2rem; font-weight: 400; color: #fff; letter-spacing: 0.02em;">LOGIN REQUIRED</h3>' +
          '<p style="margin: 0 0 2rem 0; color: #9ca3af; font-size: 1rem;">Please log in to view your bag</p>' +
          '<a href="/login?redirect=/cart" style="display: inline-block; padding: 0.875rem 2rem; background: #dc2626; color: #fff; text-decoration: none; font-family: Inter, sans-serif; font-weight: 700; font-weight: 400; font-size: 1.125rem; border-radius: 8px; letter-spacing: 0.04em;">LOGIN</a>' +
        '</div>' +
      '</div>';
    return;
  }
  
  var cart = getCart();
  var items = cart.items || [];
  console.log('[Cart] Items:', items);
  
  if (items.length === 0) {
    container.innerHTML = 
      '<div style="background: linear-gradient(to bottom, #1f2937 0%, #111827 100%); border: 2px solid rgba(255, 255, 255, 0.1); border-radius: 12px; overflow: hidden;">' +
        '<div style="padding: 1rem 1.25rem; background: linear-gradient(to right, #374151 0%, #1f2937 100%); border-bottom: 2px solid #dc2626;">' +
          '<h2 style="font-family: Inter, sans-serif; font-weight: 700; font-size: 1.5rem; font-weight: 400; letter-spacing: 0.04em; color: #fff; margin: 0;">YOUR BAG</h2>' +
        '</div>' +
        '<div style="text-align: center; padding: 4rem 2rem;">' +
          '<div style="font-size: 4rem; margin-bottom: 1.5rem; filter: grayscale(1); opacity: 0.5;">🎵</div>' +
          '<h3 style="margin: 0 0 0.75rem 0; font-family: Inter, sans-serif; font-weight: 700; font-size: 2rem; font-weight: 400; color: #dc2626; letter-spacing: 0.02em;">YOUR BAG IS EMPTY</h3>' +
          '<p style="margin: 0 0 2rem 0; color: #9ca3af; font-size: 1rem;">Time to dig for some fresh wax</p>' +
          '<a href="/" style="display: inline-block; padding: 0.875rem 2rem; background: #dc2626; color: #fff; text-decoration: none; font-family: Inter, sans-serif; font-weight: 700; font-weight: 400; font-size: 1.125rem; border-radius: 8px; letter-spacing: 0.04em;">BROWSE RELEASES</a>' +
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
    var artistName = item.artist || '';
    var isPreOrder = item.isPreOrder || false;
    var releaseDate = item.releaseDate || null;
    
    // Format release date if pre-order
    var releaseDateFormatted = '';
    if (isPreOrder && releaseDate) {
      try {
        var d = new Date(releaseDate);
        releaseDateFormatted = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      } catch (e) {}
    }
    
    // Check if quantity adjustable (vinyl/merch yes, digital no)
    var canAdjustQty = itemType === 'vinyl' || itemType === 'merch';
    
    // Badge text
    var badgeText = isPreOrder ? 'Pre-order' : itemType;
    
    itemsHTML += 
      '<article style="display: flex; align-items: stretch; gap: 1.25rem; padding: 1.25rem; background: linear-gradient(to bottom, #1f2937 0%, #111827 100%); border: 2px solid ' + (isPreOrder ? 'rgba(249, 115, 22, 0.3)' : 'rgba(255, 255, 255, 0.1)') + '; border-radius: 10px; transition: all 0.2s;">' +
        '<div style="width: 80px; height: 80px; border-radius: 8px; overflow: hidden; background: #111; border: 2px solid rgba(255, 255, 255, 0.15); flex-shrink: 0; position: relative; align-self: flex-start;">' +
          '<img src="' + itemImage + '" alt="' + itemName + '" style="width: 80px; height: 80px; object-fit: cover; display: block;" onerror="this.src=\'/logo.webp\'">' +
          (isPreOrder ? '<div style="position: absolute; top: 0; right: 0; background: linear-gradient(135deg, #f97316, #dc2626); padding: 0.125rem 0.375rem; font-size: 0.5rem; font-weight: 700; color: #fff; text-transform: uppercase; border-bottom-left-radius: 4px;">⏰</div>' : '') +
        '</div>' +
        '<div style="flex: 1; min-width: 0; display: flex; flex-direction: column;">' +
          '<h3 style="margin: 0 0 0.375rem 0; font-family: Inter, sans-serif; font-weight: 700; font-size: 1.5rem; color: #dc2626; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; letter-spacing: 0.02em;">' + itemName + '</h3>' +
          (artistName ? '<p style="margin: 0 0 0.5rem 0; font-size: 1rem; color: #9ca3af;">' + artistName + '</p>' : '') +
          '<div style="display: flex; gap: 0.625rem; flex-wrap: wrap; align-items: center; margin-top: auto;">' +
            (itemType === 'vinyl' ? '<span style="display: inline-block; padding: 0.25rem 0.625rem; font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; border-radius: 4px; border: 1.5px solid; background: #052e16; color: #22c55e; border-color: #22c55e;">Digital</span>' : '') +
            '<span style="display: inline-block; padding: 0.25rem 0.625rem; font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; border-radius: 4px; border: 1.5px solid; ' + getBadgeStyle(itemType, isPreOrder) + '">' + badgeText + '</span>' +
            (isPreOrder && releaseDateFormatted ? '<span style="font-size: 0.8rem; color: #f97316;">Available: ' + releaseDateFormatted + '</span>' : '') +
            (item.color ? '<span style="font-size: 0.95rem; color: #9ca3af;">' + (typeof item.color === 'object' ? item.color.name : item.color) + '</span>' : '') +
            (item.size ? '<span style="font-size: 0.95rem; color: #9ca3af;">Size: ' + item.size + '</span>' : '') +
          '</div>' +
        '</div>' +
        (canAdjustQty ? 
          '<div style="display: flex; flex-direction: column; align-items: center; gap: 0.375rem; flex-shrink: 0; margin-right: 1.5rem; justify-content: flex-end;">' +
            '<span style="font-size: 0.7rem; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em;">Quantity</span>' +
            '<div style="display: flex; align-items: center; gap: 0.375rem;">' +
              '<button onclick="updateQuantity(' + i + ', ' + (quantity - 1) + ')" class="qty-btn" style="width: 32px; height: 32px; background: transparent; border: 2px solid rgba(255,255,255,0.3); border-radius: 6px; color: #fff; font-size: 1.125rem; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s;"' + (quantity <= 1 ? ' disabled style="width: 32px; height: 32px; background: transparent; border: 2px solid rgba(255,255,255,0.15); border-radius: 6px; color: #4b5563; font-size: 1.125rem; cursor: not-allowed; display: flex; align-items: center; justify-content: center;"' : '') + '>−</button>' +
              '<span style="min-width: 32px; text-align: center; font-size: 1.125rem; font-weight: 700; color: #fff;">' + quantity + '</span>' +
              '<button onclick="updateQuantity(' + i + ', ' + (quantity + 1) + ')" class="qty-btn" style="width: 32px; height: 32px; background: transparent; border: 2px solid rgba(255,255,255,0.3); border-radius: 6px; color: #fff; font-size: 1.125rem; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s;"' + (quantity >= 10 ? ' disabled style="width: 32px; height: 32px; background: transparent; border: 2px solid rgba(255,255,255,0.15); border-radius: 6px; color: #4b5563; font-size: 1.125rem; cursor: not-allowed; display: flex; align-items: center; justify-content: center;"' : '') + '>+</button>' +
            '</div>' +
          '</div>' 
        : '') +
        '<div style="text-align: right; flex-shrink: 0; min-width: 90px; display: flex; flex-direction: column; justify-content: flex-end;">' +
          '<div style="font-size: 1.375rem; font-weight: 700; color: #fff;">£' + priceTotal + '</div>' +
          (quantity > 1 ? '<div style="font-size: 0.875rem; color: #6b7280;">£' + priceEach + ' each</div>' : '') +
        '</div>' +
        '<button onclick="removeItem(' + i + ')" style="width: 32px; height: 32px; background: transparent; border: none; color: #6b7280; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: color 0.2s; align-self: flex-end;" title="Remove item">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
        '</button>' +
      '</article>';
  }
  
  var shippingText = hasPhysicalItems ? (shipping === 0 ? 'FREE' : '£' + shipping.toFixed(2)) : 'Digital delivery';
  var shippingColor = !hasPhysicalItems || shipping === 0 ? '#22c55e' : '#fff';
  
  var freeShippingHint = '';
  if (hasPhysicalItems && shipping > 0 && subtotal < 50) {
    freeShippingHint = 
      '<div style="padding: 0.75rem 1rem; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; text-align: center;">' +
        '<span style="font-size: 0.875rem; color: #9ca3af;">🚚 Add <strong style="color: #fff;">£' + (50 - subtotal).toFixed(2) + '</strong> more for free shipping</span>' +
      '</div>';
  } else if (hasPhysicalItems && shipping === 0 && subtotal >= 50) {
    freeShippingHint = 
      '<div style="padding: 0.75rem 1rem; background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 8px; text-align: center;">' +
        '<span style="font-size: 0.875rem; color: #22c55e;">✓ Free shipping on orders over £50!</span>' +
      '</div>';
  }
  
  container.innerHTML = 
    '<div style="background: linear-gradient(to bottom, #1f2937 0%, #111827 100%); border: 2px solid rgba(255, 255, 255, 0.1); border-radius: 12px; margin-bottom: 1.5rem; overflow: hidden;">' +
      '<div style="display: flex; align-items: center; justify-content: space-between; padding: 1rem 1.25rem; background: linear-gradient(to right, #374151 0%, #1f2937 100%); border-bottom: 2px solid #dc2626;">' +
        '<h2 style="font-family: Inter, sans-serif; font-weight: 700; font-size: 1.5rem; font-weight: 400; letter-spacing: 0.04em; color: #fff; margin: 0;">YOUR BAG</h2>' +
        '<span style="font-size: 0.875rem; color: #9ca3af; font-weight: 500;">' + itemCount + ' ' + (itemCount === 1 ? 'item' : 'items') + '</span>' +
      '</div>' +
      '<div style="padding: 1rem;">' +
        '<div style="display: flex; flex-direction: column; gap: 0.75rem;">' + itemsHTML + '</div>' +
      '</div>' +
    '</div>' +
    '<div style="background: linear-gradient(to bottom, #1f2937 0%, #111827 100%); border: 2px solid rgba(255, 255, 255, 0.1); border-radius: 12px; overflow: hidden;">' +
      '<div style="padding: 1rem 1.25rem; background: linear-gradient(to right, #374151 0%, #1f2937 100%); border-bottom: 2px solid #dc2626;">' +
        '<h2 style="font-family: Inter, sans-serif; font-weight: 700; font-size: 1.5rem; font-weight: 400; letter-spacing: 0.04em; color: #fff; margin: 0;">ORDER SUMMARY</h2>' +
      '</div>' +
      '<div style="padding: 1.25rem;">' +
        '<div style="display: flex; flex-direction: column; gap: 0.75rem; margin-bottom: 1.25rem;">' +
          '<div style="display: flex; justify-content: space-between; align-items: center;">' +
            '<span style="font-size: 0.9375rem; color: #9ca3af;">Subtotal</span>' +
            '<span style="font-size: 1rem; font-weight: 600; color: #fff;">£' + subtotal.toFixed(2) + '</span>' +
          '</div>' +
          '<div style="display: flex; justify-content: space-between; align-items: center;">' +
            '<span style="font-size: 0.9375rem; color: #9ca3af;">Shipping</span>' +
            '<span style="font-size: 1rem; font-weight: 600; color: ' + shippingColor + ';">' + shippingText + '</span>' +
          '</div>' +
          freeShippingHint +
        '</div>' +
        '<div style="display: flex; justify-content: space-between; align-items: center; padding: 1rem 1.25rem; background: rgba(0,0,0,0.3); border: 2px solid rgba(255,255,255,0.15); border-radius: 10px; margin-bottom: 1.25rem;">' +
          '<span style="font-family: Inter, sans-serif; font-weight: 700; font-size: 1.375rem; letter-spacing: 0.04em; color: #fff;">TOTAL</span>' +
          '<span style="font-size: 1.75rem; font-weight: 700; color: #dc2626;">£' + total.toFixed(2) + '</span>' +
        '</div>' +
        '<button onclick="goToCheckout()" style="width: 100%; padding: 1rem; background: #dc2626; color: #fff; border: none; border-radius: 10px; font-family: Inter, sans-serif; font-weight: 700; font-size: 1.375rem; font-weight: 400; letter-spacing: 0.06em; cursor: pointer; transition: all 0.2s;">' +
          'PROCEED TO CHECKOUT' +
        '</button>' +
        '<div style="display: flex; align-items: center; justify-content: center; gap: 0.5rem; margin-top: 0.875rem; font-size: 0.8125rem; color: #6b7280;">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
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