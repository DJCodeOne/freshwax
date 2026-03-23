/**
 * Release plate — pre-order system.
 * Extracted from api.ts for focused module organization.
 */

// ============================================
// PRE-ORDER SYSTEM
// ============================================
export function initPreorderSystem() {
  var preorderButtons = document.querySelectorAll('.preorder-btn');

  preorderButtons.forEach(function(btn) {
    btn.addEventListener('click', async function(e) {
      e.preventDefault();

      if (!window.FreshWaxCart || !window.FreshWaxCart.isLoggedIn()) {
        window.location.href = '/login/?redirect=' + encodeURIComponent(window.location.pathname);
        return;
      }

      var releaseId = (btn as HTMLElement).getAttribute('data-release-id');
      var title = (btn as HTMLElement).getAttribute('data-title');
      var artist = (btn as HTMLElement).getAttribute('data-artist');
      var artwork = (btn as HTMLElement).getAttribute('data-artwork');
      var price = parseFloat((btn as HTMLElement).getAttribute('data-price') || '0');
      var releaseDate = (btn as HTMLElement).getAttribute('data-release-date');

      var cart = window.FreshWaxCart.get();
      var items = cart.items || [];

      var existingIndex = -1;
      for (var i = 0; i < items.length; i++) {
        if (items[i].id === releaseId && (items[i].type === 'digital' || items[i].type === 'preorder')) {
          existingIndex = i;
          break;
        }
      }

      if (existingIndex !== -1) {
        var originalHTML = btn.innerHTML;
        btn.innerHTML = '<span class="flex items-center gap-1"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg> In Cart</span>';
        setTimeout(function() {
          btn.innerHTML = originalHTML;
        }, 1500);
        return;
      }

      items.push({
        id: releaseId,
        releaseId: releaseId,
        type: 'digital',
        format: 'digital',
        name: artist + ' - ' + title,
        title: title,
        artist: artist,
        price: price,
        image: artwork,
        artwork: artwork,
        quantity: 1,
        isPreOrder: true,
        releaseDate: releaseDate
      });

      window.FreshWaxCart.save({ items: items });
      window.FreshWaxCart.updateBadge();

      var originalHTML2 = btn.innerHTML;
      btn.innerHTML = '<span class="flex items-center gap-1"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg> Added!</span>';
      btn.classList.remove('from-orange-500', 'to-red-500');
      btn.classList.add('from-green-500', 'to-green-600');

      setTimeout(function() {
        btn.innerHTML = originalHTML2;
        btn.classList.remove('from-green-500', 'to-green-600');
        btn.classList.add('from-orange-500', 'to-red-500');
      }, 1500);
    });
  });
}
