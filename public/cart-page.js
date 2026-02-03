// Cart page logic - uses FreshWaxCart system with KV persistence

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

function updateCartCount() {
  if (window.FreshWaxCart) {
    window.FreshWaxCart.updateBadge();
  }
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
  if (!window.FreshWaxCart) return;

  var cart = window.FreshWaxCart.get();
  var items = cart.items || [];

  if (!newQuantity || newQuantity < 1) {
    items[index].quantity = 1;
  } else if (newQuantity > 10) {
    items[index].quantity = 10;
  } else {
    items[index].quantity = newQuantity;
  }

  window.FreshWaxCart.save({ items: items });
  renderCart();
}

function removeItem(index) {
  if (!window.FreshWaxCart) return;

  var cart = window.FreshWaxCart.get();
  var items = cart.items || [];
  items.splice(index, 1);
  window.FreshWaxCart.save({ items: items });
  renderCart();
}

function renderCart() {
  var container = document.getElementById('cart-content');
  if (!container) return;

  var customerId = getCustomerId();

  // Check if logged in
  if (!customerId) {
    container.innerHTML =
      '<div style="background: linear-gradient(to bottom, #1f2937 0%, #111827 100%); border: 2px solid rgba(255, 255, 255, 0.1); border-radius: 12px; overflow: hidden;">' +
        '<div style="padding: 1rem 1.25rem; background: linear-gradient(to right, #374151 0%, #1f2937 100%); border-bottom: 2px solid #dc2626;">' +
          '<h2 style="font-family: Inter, sans-serif; font-weight: 700; font-size: 1.5rem; letter-spacing: 0.04em; color: #fff; margin: 0;">YOUR BAG</h2>' +
        '</div>' +
        '<div style="text-align: center; padding: 4rem 2rem;">' +
          '<div style="font-size: 4rem; margin-bottom: 1.5rem;">🔐</div>' +
          '<h3 style="margin: 0 0 0.75rem 0; font-family: Inter, sans-serif; font-weight: 700; font-size: 2rem; color: #fff; letter-spacing: 0.02em;">LOGIN REQUIRED</h3>' +
          '<p style="margin: 0 0 2rem 0; color: #9ca3af; font-size: 1rem;">Please log in to view your bag</p>' +
          '<a href="/login?redirect=/cart" style="display: inline-block; padding: 0.875rem 2rem; background: #dc2626; color: #fff; text-decoration: none; font-family: Inter, sans-serif; font-weight: 700; font-size: 1.125rem; border-radius: 8px; letter-spacing: 0.04em;">LOGIN</a>' +
        '</div>' +
      '</div>';
    return;
  }

  // Get cart from FreshWaxCart (uses localStorage + KV sync)
  var cart = window.FreshWaxCart ? window.FreshWaxCart.get() : { items: [] };
  var items = cart.items || [];

  console.log('[Cart Page] Rendering', items.length, 'items');

  if (items.length === 0) {
    container.innerHTML =
      '<div style="background: linear-gradient(to bottom, #1f2937 0%, #111827 100%); border: 2px solid rgba(255, 255, 255, 0.1); border-radius: 12px; overflow: hidden;">' +
        '<div style="padding: 1rem 1.25rem; background: linear-gradient(to right, #374151 0%, #1f2937 100%); border-bottom: 2px solid #dc2626;">' +
          '<h2 style="font-family: Inter, sans-serif; font-weight: 700; font-size: 1.5rem; letter-spacing: 0.04em; color: #fff; margin: 0;">YOUR BAG</h2>' +
        '</div>' +
        '<div class="empty-cart" style="text-align: center; padding: 4rem 2rem;">' +
          '<div style="font-size: 4rem; margin-bottom: 1.5rem;">👜</div>' +
          '<h3 style="margin: 0 0 0.75rem 0; font-family: Inter, sans-serif; font-weight: 700; font-size: 2rem; color: #fff; letter-spacing: 0.02em;">YOUR BAG IS EMPTY</h3>' +
          '<p style="margin: 0 0 2rem 0; color: #9ca3af; font-size: 1rem;">Add some items to get started</p>' +
          '<a href="/" style="display: inline-block; padding: 0.875rem 2rem; background: #dc2626; color: #fff; text-decoration: none; font-family: Inter, sans-serif; font-weight: 700; font-size: 1.125rem; border-radius: 8px; letter-spacing: 0.04em;">BROWSE RELEASES</a>' +
        '</div>' +
      '</div>';
    return;
  }

  var totals = calculateTotals(items);

  // Build cart HTML
  var html =
    '<div style="background: linear-gradient(to bottom, #1f2937 0%, #111827 100%); border: 2px solid rgba(255, 255, 255, 0.1); border-radius: 12px; overflow: hidden;">' +
      '<div style="padding: 1rem 1.25rem; background: linear-gradient(to right, #374151 0%, #1f2937 100%); border-bottom: 2px solid #dc2626; display: flex; justify-content: space-between; align-items: center;">' +
        '<h2 style="font-family: Inter, sans-serif; font-weight: 700; font-size: 1.5rem; letter-spacing: 0.04em; color: #fff; margin: 0;">YOUR BAG</h2>' +
        '<span style="color: #9ca3af; font-size: 0.875rem;">' + items.length + ' item' + (items.length !== 1 ? 's' : '') + '</span>' +
      '</div>' +
      '<div style="padding: 1rem;">';

  // Render each item
  items.forEach(function(item, index) {
    var itemTotal = (item.price || 0) * (item.quantity || 1);
    var typeBadge = item.type || item.format || 'digital';
    var displayType = typeBadge === 'merch' ? 'MERCH' :
                      typeBadge === 'vinyl' ? 'VINYL' :
                      typeBadge === 'track' ? 'TRACK' : 'DIGITAL';
    var badgeStyle = getBadgeStyle(typeBadge, item.isPreOrder);

    html +=
      '<article style="display: flex; align-items: center; gap: 1rem; padding: 1rem; background: rgba(0,0,0,0.3); border-radius: 8px; margin-bottom: 0.75rem; border: 1px solid rgba(255,255,255,0.1);">' +
        '<div style="width: 64px; height: 64px; flex-shrink: 0; border-radius: 6px; overflow: hidden; border: 2px solid rgba(255,255,255,0.2);">' +
          '<img src="' + (item.image || item.artwork || '/place-holder.webp') + '" alt="" style="width: 100%; height: 100%; object-fit: cover;" onerror="this.src=\'/place-holder.webp\'">' +
        '</div>' +
        '<div style="flex: 1; min-width: 0;">' +
          '<h3 style="margin: 0 0 0.25rem 0; font-size: 1rem; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">' + (item.name || item.title || 'Item') + '</h3>' +
          '<div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">' +
            '<span style="display: inline-block; padding: 0.125rem 0.5rem; font-size: 0.625rem; font-weight: 700; border-radius: 4px; border: 1px solid; ' + badgeStyle + '">' + displayType + '</span>' +
            (item.size ? '<span style="color: #9ca3af; font-size: 0.75rem;">Size: ' + item.size + '</span>' : '') +
            (item.color ? '<span style="color: #9ca3af; font-size: 0.75rem;">Color: ' + item.color + '</span>' : '') +
            (item.artist ? '<span style="color: #9ca3af; font-size: 0.75rem;">by ' + (item.artist === 'Various Artists' && item.labelName ? item.labelName : item.artist) + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div style="display: flex; align-items: center; gap: 0.5rem;">' +
          '<button onclick="updateQuantity(' + index + ', ' + ((item.quantity || 1) - 1) + ')" style="width: 28px; height: 28px; border: 1px solid rgba(255,255,255,0.3); background: transparent; color: #fff; border-radius: 4px; cursor: pointer; font-size: 1rem;">−</button>' +
          '<span style="color: #fff; min-width: 24px; text-align: center;">' + (item.quantity || 1) + '</span>' +
          '<button onclick="updateQuantity(' + index + ', ' + ((item.quantity || 1) + 1) + ')" style="width: 28px; height: 28px; border: 1px solid rgba(255,255,255,0.3); background: transparent; color: #fff; border-radius: 4px; cursor: pointer; font-size: 1rem;">+</button>' +
        '</div>' +
        '<div style="text-align: right; min-width: 70px;">' +
          '<div style="color: #fff; font-weight: 700;">£' + itemTotal.toFixed(2) + '</div>' +
          (item.quantity > 1 ? '<div style="color: #9ca3af; font-size: 0.75rem;">£' + (item.price || 0).toFixed(2) + ' each</div>' : '') +
        '</div>' +
        '<button onclick="removeItem(' + index + ')" style="width: 32px; height: 32px; border: none; background: rgba(220, 38, 38, 0.2); color: #dc2626; border-radius: 6px; cursor: pointer; font-size: 1.25rem;" title="Remove">×</button>' +
      '</article>';
  });

  // Totals section
  html +=
      '</div>' +
      '<div style="padding: 1.25rem; border-top: 2px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.3);">' +
        '<div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">' +
          '<span style="color: #9ca3af;">Subtotal</span>' +
          '<span style="color: #fff;">£' + totals.subtotal.toFixed(2) + '</span>' +
        '</div>';

  if (totals.hasPhysicalItems) {
    html +=
        '<div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">' +
          '<span style="color: #9ca3af;">Shipping</span>' +
          '<span style="color: #fff;">' + (totals.shipping === 0 ? 'FREE' : '£' + totals.shipping.toFixed(2)) + '</span>' +
        '</div>';

    if (totals.shipping > 0) {
      var amountForFree = (50 - totals.subtotal).toFixed(2);
      html +=
        '<div style="font-size: 0.75rem; color: #22c55e; margin-bottom: 0.75rem;">Spend £' + amountForFree + ' more for FREE shipping!</div>';
    }
  }

  html +=
        '<div style="display: flex; justify-content: space-between; padding-top: 0.75rem; border-top: 1px solid rgba(255,255,255,0.1);">' +
          '<span style="color: #fff; font-weight: 700; font-size: 1.125rem;">Total</span>' +
          '<span style="color: #fff; font-weight: 700; font-size: 1.25rem;">£' + totals.total.toFixed(2) + '</span>' +
        '</div>' +
        '<button onclick="goToCheckout()" style="width: 100%; margin-top: 1rem; padding: 1rem; background: #dc2626; color: #fff; border: none; border-radius: 8px; font-size: 1rem; font-weight: 700; cursor: pointer; letter-spacing: 0.04em;">PROCEED TO CHECKOUT</button>' +
        '<a href="/" style="display: block; text-align: center; margin-top: 0.75rem; color: #9ca3af; text-decoration: none; font-size: 0.875rem;">← Continue Shopping</a>' +
      '</div>' +
    '</div>';

  container.innerHTML = html;
}

function goToCheckout() {
  window.location.href = '/checkout';
}

// Simple init - just render the cart
function init() {
  var container = document.getElementById('cart-content');
  if (!container) return;

  console.log('[Cart Page] Init called');

  // Always render - let renderCart handle the logic
  updateCartCount();
  renderCart();

  // Also try to sync with KV in background (non-blocking)
  if (window.FreshWaxCart && window.FreshWaxCart.loadFromKV) {
    window.FreshWaxCart.loadFromKV().then(function(kvCart) {
      if (kvCart && kvCart.items && kvCart.items.length > 0) {
        var localCart = window.FreshWaxCart.get();
        var localTime = localCart.updatedAt ? new Date(localCart.updatedAt).getTime() : 0;
        var kvTime = kvCart.updatedAt ? new Date(kvCart.updatedAt).getTime() : 0;

        if (kvTime > localTime) {
          console.log('[Cart Page] KV has newer cart, updating');
          window.FreshWaxCart.save(kvCart);
          renderCart();
        }
      }
    }).catch(function(err) {
      console.log('[Cart Page] KV sync skipped:', err);
    });
  }
}

// Listen for cart updates
window.addEventListener('cart-updated', function() {
  if (document.getElementById('cart-content')) {
    updateCartCount();
    renderCart();
  }
});

window.addEventListener('cartUpdated', function() {
  if (document.getElementById('cart-content')) {
    updateCartCount();
    renderCart();
  }
});

// Handle Astro View Transitions
document.addEventListener('astro:page-load', function() {
  console.log('[Cart Page] page-load');
  init();
});

// Initial load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
