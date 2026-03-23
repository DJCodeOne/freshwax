/**
 * Release plate — wishlist system.
 * Extracted from api.ts for focused module organization.
 */
import { createClientLogger } from '../client-logger';

const log = createClientLogger('ReleasePlate');

// ============================================
// WISHLIST SYSTEM
// ============================================
export function initWishlistSystem() {
  if (window._wishlistInitialized) return;
  window._wishlistInitialized = true;

  var wishlistButtons = document.querySelectorAll('.wishlist-btn');

  async function fetchWishlistState() {
    var user = window.firebaseAuth?.currentUser;
    if (user && wishlistButtons.length > 0) {
      try {
        var token = await user.getIdToken();
        fetch('/api/wishlist/?userId=' + user.uid, {
          headers: { 'Authorization': 'Bearer ' + token }
        })
          .then(function(res) { return res.ok ? res.json() : null; })
          .then(function(data) {
            if (data && data.success && data.wishlist) {
              var wishlistIds = data.wishlist.map(function(r: WishlistEntry) { return r.id; });
              wishlistButtons.forEach(function(btn) {
                var releaseId = btn.getAttribute('data-release-id');
                if (wishlistIds.includes(releaseId)) {
                  setWishlistState(btn, true);
                }
              });
            }
          })
          .catch(function(err: unknown) {
            log.error('Failed to load wishlist state:', err);
          });
      } catch (err: unknown) {
        log.error('Failed to get auth token for wishlist:', err);
      }
    }
  }

  if (window.authReady) {
    window.authReady.then(function(user: FirebaseAuthUser | null) {
      if (user) fetchWishlistState();
    });
  } else if (window.firebaseAuth) {
    window.firebaseAuth.onAuthStateChanged(function(user: FirebaseAuthUser | null) {
      if (user) fetchWishlistState();
    });
  }

  document.addEventListener('click', async function(e) {
    var btn = (e.target as HTMLElement).closest('.wishlist-btn') as HTMLElement | null;
    if (!btn) return;

    e.preventDefault();
    e.stopPropagation();

    var user = window.firebaseAuth?.currentUser;
    var releaseId = btn.getAttribute('data-release-id');

    if (!user) {
      window.showToast?.('Please log in to add items to your wishlist');
      return;
    }

    btn.style.opacity = '0.5';
    btn.style.pointerEvents = 'none';

    try {
      var token = await user.getIdToken();

      fetch('/api/wishlist/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({
          userId: user.uid,
          releaseId: releaseId,
          action: 'toggle'
        })
      })
      .then(function(res) { return res.ok ? res.json() : null; })
      .then(function(data) {
        btn!.style.opacity = '1';
        btn!.style.pointerEvents = 'auto';

        if (data && data.success) {
          setWishlistState(btn!, data.inWishlist);
          window.showToast?.(data.inWishlist ? 'Added to wishlist!' : 'Removed from wishlist');
        } else {
          window.showToast?.('Failed to update wishlist');
        }
      })
      .catch(function(err: unknown) {
        btn!.style.opacity = '1';
        btn!.style.pointerEvents = 'auto';
        log.error('Wishlist error:', err);
        window.showToast?.('Failed to update wishlist');
      });
    } catch (err: unknown) {
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
      log.error('Auth error:', err);
      window.showToast?.('Authentication error');
    }
  });
}

function setWishlistState(btn: Element, inWishlist: boolean) {
  var emptyIcon = btn.querySelector('.wishlist-icon-empty');
  var filledIcon = btn.querySelector('.wishlist-icon-filled');
  var textSpan = btn.querySelector('.wishlist-text');

  if (inWishlist) {
    if (emptyIcon) emptyIcon.classList.add('hidden');
    if (filledIcon) filledIcon.classList.remove('hidden');
    if (textSpan) textSpan.textContent = 'Wishlisted';
    btn.setAttribute('title', 'Remove from wishlist');
  } else {
    if (emptyIcon) emptyIcon.classList.remove('hidden');
    if (filledIcon) filledIcon.classList.add('hidden');
    if (textSpan) textSpan.textContent = 'Wishlist';
    btn.setAttribute('title', 'Add to wishlist');
  }
}
