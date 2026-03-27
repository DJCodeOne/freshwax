/**
 * Release plate — pre-order system.
 * Extracted from api.ts for focused module organization.
 */

// ============================================
// PRE-ORDER SYSTEM
// ============================================
export function initPreorderSystem() {
  const preorderButtons = document.querySelectorAll('.preorder-btn');

  preorderButtons.forEach(function(btn) {
    btn.addEventListener('click', async function(e) {
      e.preventDefault();

      if (!window.FreshWaxCart || !window.FreshWaxCart.isLoggedIn()) {
        window.location.href = '/login/?redirect=' + encodeURIComponent(window.location.pathname);
        return;
      }

      const releaseId = (btn as HTMLElement).getAttribute('data-release-id');
      const title = (btn as HTMLElement).getAttribute('data-title');
      const artist = (btn as HTMLElement).getAttribute('data-artist');
      const artwork = (btn as HTMLElement).getAttribute('data-artwork');
      const price = parseFloat((btn as HTMLElement).getAttribute('data-price') || '0');
      const releaseDate = (btn as HTMLElement).getAttribute('data-release-date');

      const cart = window.FreshWaxCart.get();
      const items = cart.items || [];

      let existingIndex = -1;
      for (let i = 0; i < items.length; i++) {
        if (items[i].id === releaseId && (items[i].type === 'digital' || items[i].type === 'preorder')) {
          existingIndex = i;
          break;
        }
      }

      if (existingIndex !== -1) {
        const originalHTML = btn.innerHTML;
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

      const originalHTML2 = btn.innerHTML;
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
