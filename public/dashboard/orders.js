// Dashboard — orders tab module
// Handles order rendering and stats calculation

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

var ctx = null;

export function init(context) {
  ctx = context;
}

// Render orders into a container
export function renderOrders(ordersList, containerId) {
  var container = document.getElementById(containerId);
  if (!container) return;

  if (!ordersList || ordersList.length === 0) {
    container.innerHTML =
      '<div class="empty-state">' +
        '<p style="color: #fff; margin: 0 0 1.5rem 0;">No orders yet</p>' +
        '<a href="/" style="display: inline-block; padding: 0.75rem 1.5rem; background: #dc2626; color: #fff; font-weight: 600; border-radius: 8px; text-decoration: none;">Start Shopping</a>' +
      '</div>';
    return;
  }

  container.innerHTML = ordersList.map(function(order) {
    var orderDate = order.createdAt ? new Date(order.createdAt).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric'
    }) : '';

    // Use status (new) or orderStatus (legacy) for compatibility
    var orderStatus = order.status || order.orderStatus;
    var statusClass = orderStatus === 'completed' ? 'status-completed' :
                      orderStatus === 'shipped' ? 'status-shipped' : 'status-processing';
    var statusText = orderStatus ? orderStatus.charAt(0).toUpperCase() + orderStatus.slice(1) : 'Processing';

    var items = order.items || [];

    return '<div class="order-card">' +
      '<div class="order-header">' +
        '<div class="order-header-left">' +
          '<div class="order-number">' + escapeHtml(order.orderNumber || 'Order') + '</div>' +
          '<div class="order-date">' + escapeHtml(orderDate) + '</div>' +
        '</div>' +
        '<div class="order-header-right">' +
          '<div class="order-total">£' + (order.totals?.total?.toFixed(2) || '0.00') + '</div>' +
          '<span class="order-status ' + statusClass + '">' + escapeHtml(statusText) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="order-items">' +
        items.map(function(item) {
          var itemType = item.type || item.productType || 'digital';
          var typeClass = itemType === 'vinyl' ? 'vinyl' :
                         itemType === 'merch' ? 'merch' :
                         itemType === 'track' ? 'track' : 'digital';
          var itemImage = item.image || item.artwork || item.artworkUrl || item.coverArtUrl || item.downloads?.artworkUrl || '/place-holder.webp';
          return '<div class="order-item">' +
            '<img src="' + escapeHtml(itemImage) + '" alt="' + escapeHtml(item.name || item.title || 'Order item') + '" class="order-item-image" width="64" height="64" loading="lazy" decoding="async">' +
            '<div class="order-item-details">' +
              '<div class="order-item-name">' + escapeHtml(item.name || item.title || 'Item') + '</div>' +
              '<div class="order-item-meta">' +
                '<span class="order-item-type ' + typeClass + '">' + escapeHtml(itemType) + '</span>' +
                (item.quantity > 1 ? '<span class="order-item-qty">&times; ' + item.quantity + '</span>' : '') +
              '</div>' +
            '</div>' +
            '<div class="order-item-price">£' + ((item.price || 0) * (item.quantity || 1)).toFixed(2) + '</div>' +
          '</div>';
        }).join('') +
      '</div>' +
      '<a href="/order-confirmation/' + escapeHtml(order.id) + '/" class="order-view-link">' +
        'View Order Details' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
          '<path d="M5 12h14M12 5l7 7-7 7"/>' +
        '</svg>' +
      '</a>' +
    '</div>';
  }).join('');
}

// Update stats from orders
export function updateStats(ordersList) {
  var orderCount = ordersList?.length || 0;
  var totalSpent = ordersList?.reduce(function(sum, o) { return sum + (o.totals?.total || o.total || 0); }, 0) || 0;

  // Count vinyl, digital EPs (unique releases), tracks (unique track names), and merch
  var vinylCount = 0;
  var merchCount = 0;
  var uniqueReleases = new Set(); // Track unique digital releases
  var uniqueTracks = new Set(); // Track unique track names

  (ordersList || []).forEach(function(order) {
    (order.items || []).forEach(function(item) {
      // Check if it's merch
      var isMerch = item.type === 'merch' ||
                    item.type === 'merchandise' ||
                    (item.releaseId && item.releaseId.startsWith('merch_')) ||
                    (item.productId && item.productId.startsWith('merch_'));

      // Check if it's vinyl
      var isVinyl = item.type === 'vinyl' ||
                    item.format === 'vinyl' ||
                    item.isVinyl === true ||
                    (item.productType && item.productType.toLowerCase().includes('vinyl'));

      if (isMerch) {
        merchCount += item.quantity || 1;
      } else if (isVinyl) {
        vinylCount += item.quantity || 1;
      } else if (item.downloads?.tracks?.length > 0 || item.type === 'digital' || item.type === 'release' || item.type === 'track') {
        // It's a digital music item - track unique releases
        var releaseKey = item.releaseId || item.productId || item.id;
        if (releaseKey) {
          uniqueReleases.add(releaseKey);
        }

        // Count unique track names (not formats)
        if (item.downloads?.tracks) {
          item.downloads.tracks.forEach(function(track) {
            var trackName = track.name || track.title || track.trackName;
            if (trackName) {
              uniqueTracks.add(trackName);
            }
          });
        }
      }
    });
  });

  var statOrdersEl = document.getElementById('statOrders');
  if (statOrdersEl) statOrdersEl.textContent = orderCount;
  var ordersBadge = document.getElementById('ordersBadge');
  if (ordersBadge) {
    ordersBadge.textContent = orderCount;
    ordersBadge.style.display = orderCount > 0 ? 'inline-flex' : 'none';
  }
  var statVinylEl = document.getElementById('statVinyl');
  if (statVinylEl) statVinylEl.textContent = vinylCount;
  var statDigitalEPsEl = document.getElementById('statDigitalEPs');
  if (statDigitalEPsEl) statDigitalEPsEl.textContent = uniqueReleases.size;
  var statTracksEl = document.getElementById('statTracks');
  if (statTracksEl) statTracksEl.textContent = uniqueTracks.size;
  var statMerchEl = document.getElementById('statMerch');
  if (statMerchEl) statMerchEl.textContent = merchCount;
  var statSpentEl = document.getElementById('statSpent');
  if (statSpentEl) statSpentEl.textContent = '£' + totalSpent.toFixed(2);
}
