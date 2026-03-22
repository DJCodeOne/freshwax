/**
 * Release plate API — rating system, user ratings, wishlist, preorder, NYOP.
 */
import { createClientLogger } from '../client-logger';
import { FWCache, getAuthUser } from './cache';

const log = createClientLogger('ReleasePlate');

// ============================================
// RATING SYSTEM
// ============================================
var ratingDebounce: Record<string, boolean> = {};
var pendingRatingsRequest: Promise<any> | null = null;

export function initRatingSystem() {
  var releaseCards = document.querySelectorAll('[data-release]');
  var needsFetch: string[] = [];

  releaseCards.forEach(function(card) {
    if (card.hasAttribute('data-ratings-init')) return;
    card.setAttribute('data-ratings-init', 'true');

    var id = card.getAttribute('data-release');
    if (!id) return;

    var hasServerRatings = card.getAttribute('data-has-server-ratings') === 'true';
    if (hasServerRatings) return;

    var cached = FWCache.get('ratings');
    if (cached && cached[id]) {
      updateSingleRatingUI(card, id, cached[id]);
    } else {
      needsFetch.push(id);
    }
  });

  if (needsFetch.length === 0) {
    setupRatingClickHandlers();
    return;
  }

  if (pendingRatingsRequest) {
    pendingRatingsRequest.then(function(ratings) {
      releaseCards.forEach(function(card) {
        var id = card.getAttribute('data-release');
        if (ratings && id && ratings[id]) {
          updateSingleRatingUI(card, id, ratings[id]);
        }
      });
    });
    setupRatingClickHandlers();
    return;
  }

  pendingRatingsRequest = fetch('/api/get-ratings-batch/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ releaseIds: needsFetch })
  })
  .then(function(response) { return response.ok ? response.json() : null; })
  .then(function(data) {
    pendingRatingsRequest = null;
    if (data && data.success && data.ratings) {
      FWCache.update('ratings', function(current: any) {
        return Object.assign({}, current, data.ratings);
      });
      return data.ratings;
    }
    return {};
  })
  .catch(function(error: unknown) {
    pendingRatingsRequest = null;
    return {};
  });

  pendingRatingsRequest.then(function(ratings) {
    releaseCards.forEach(function(card) {
      var id = card.getAttribute('data-release');
      if (ratings && id && ratings[id]) {
        updateSingleRatingUI(card, id, ratings[id]);
      }
    });
  });

  setupRatingClickHandlers();
}

function updateSingleRatingUI(card: Element, releaseId: string, ratingData: any) {
  var average = ratingData.average || 0;
  var count = ratingData.count || 0;

  var ratingValue = card.querySelector('.rating-value[data-release-id="' + releaseId + '"]');
  var ratingCount = card.querySelector('.rating-count[data-release-id="' + releaseId + '"]');

  if (ratingValue) ratingValue.textContent = average.toFixed(1);
  if (ratingCount) ratingCount.textContent = ' (' + count + ')';
}

function setupRatingClickHandlers() {
  document.querySelectorAll('.rating-star').forEach(function(star) {
    if (star.hasAttribute('data-rating-click-init')) return;
    star.setAttribute('data-rating-click-init', 'true');

    (star as HTMLElement).onclick = async function() {
      var releaseId = star.getAttribute('data-release-id');
      var rating = parseInt(star.getAttribute('data-star') || '0');

      if (!releaseId) return;

      if (ratingDebounce[releaseId]) return;
      ratingDebounce[releaseId] = true;
      setTimeout(function() { delete ratingDebounce[releaseId]; }, 2000);

      var user = await getAuthUser();
      if (!user) {
        alert('Please log in to rate releases.');
        var currentPage = window.location.pathname;
        window.location.href = '/login/?redirect=' + encodeURIComponent(currentPage);
        return;
      }

      var idToken: string | null = null;
      try {
        if ((window as any).firebaseAuth && (window as any).firebaseAuth.currentUser) {
          idToken = await (window as any).firebaseAuth.currentUser.getIdToken();
        }
      } catch (e: unknown) { /* Ignore token errors */ }

      var card = document.querySelector('[data-release="' + releaseId + '"]');

      // Optimistic UI update
      if (card) {
        card.querySelectorAll('.rating-star[data-release-id="' + releaseId + '"]').forEach(function(s) {
          var starNum = parseInt(s.getAttribute('data-star') || '0');
          var svg = s.querySelector('svg');
          if (svg) {
            svg.setAttribute('fill', starNum <= rating ? 'currentColor' : 'none');
          }
        });
      }

      var headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (idToken) {
        headers['Authorization'] = 'Bearer ' + idToken;
      }

      fetch('/api/rate-release/', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ releaseId: releaseId, rating: rating, userId: user.uid })
      })
      .then(function(response) { return response.ok ? response.json() : null; })
      .then(function(data) {
        if (data && data.success) {
          FWCache.update('ratings', function(current: any) {
            current[releaseId] = { average: data.newRating, count: data.ratingsCount };
            return current;
          });

          if (card) {
            var ratingValue = card.querySelector('.rating-value[data-release-id="' + releaseId + '"]');
            var ratingCount = card.querySelector('.rating-count[data-release-id="' + releaseId + '"]');
            if (ratingValue) ratingValue.textContent = data.newRating.toFixed(1);
            if (ratingCount) ratingCount.textContent = ' (' + data.ratingsCount + ')';
          }
        }
      })
      .catch(function(error: unknown) { log.error('Rating submission error:', error); });
    };
  });
}

// ============================================
// USER RATINGS
// ============================================
var userRatingsFetched = false;

export async function fetchUserRatings() {
  if (userRatingsFetched) return;

  var user = await getAuthUser();
  if (!user) return;

  userRatingsFetched = true;

  var releaseCards = document.querySelectorAll('[data-release]');
  var releaseIds: string[] = [];
  releaseCards.forEach(function(card) {
    var id = card.getAttribute('data-release');
    if (id) releaseIds.push(id);
  });

  if (releaseIds.length === 0) return;

  var idToken: string | null = null;
  try {
    if ((window as any).firebaseAuth && (window as any).firebaseAuth.currentUser) {
      idToken = await (window as any).firebaseAuth.currentUser.getIdToken();
    }
  } catch (e: unknown) { /* Ignore */ }

  if (!idToken) return;

  try {
    var response = await fetch('/api/get-user-ratings/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + idToken
      },
      body: JSON.stringify({ releaseIds: releaseIds })
    });

    if (!response.ok) return;
    var data = await response.json();

    if (data.success && data.userRatings) {
      Object.keys(data.userRatings).forEach(function(releaseId: string) {
        var userRating = data.userRatings[releaseId];
        var card = document.querySelector('[data-release="' + releaseId + '"]');
        if (card) {
          card.querySelectorAll('.rating-star[data-release-id="' + releaseId + '"]').forEach(function(star) {
            var starNum = parseInt(star.getAttribute('data-star') || '0');
            var svg = star.querySelector('svg');
            if (svg) {
              svg.setAttribute('fill', starNum <= userRating ? 'currentColor' : 'none');
            }
          });
        }
      });
    }
  } catch (e: unknown) {
    log.error('Failed to fetch user ratings:', e);
  }
}

// ============================================
// WISHLIST SYSTEM
// ============================================
export function initWishlistSystem() {
  if ((window as any)._wishlistInitialized) return;
  (window as any)._wishlistInitialized = true;

  var wishlistButtons = document.querySelectorAll('.wishlist-btn');

  async function fetchWishlistState() {
    var user = (window as any).firebaseAuth?.currentUser;
    if (user && wishlistButtons.length > 0) {
      try {
        var token = await user.getIdToken();
        fetch('/api/wishlist/?userId=' + user.uid, {
          headers: { 'Authorization': 'Bearer ' + token }
        })
          .then(function(res) { return res.ok ? res.json() : null; })
          .then(function(data) {
            if (data && data.success && data.wishlist) {
              var wishlistIds = data.wishlist.map(function(r: any) { return r.id; });
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

  if ((window as any).authReady) {
    (window as any).authReady.then(function(user: any) {
      if (user) fetchWishlistState();
    });
  } else if ((window as any).firebaseAuth) {
    (window as any).firebaseAuth.onAuthStateChanged(function(user: any) {
      if (user) fetchWishlistState();
    });
  }

  document.addEventListener('click', async function(e) {
    var btn = (e.target as HTMLElement).closest('.wishlist-btn') as HTMLElement | null;
    if (!btn) return;

    e.preventDefault();
    e.stopPropagation();

    var user = (window as any).firebaseAuth?.currentUser;
    var releaseId = btn.getAttribute('data-release-id');

    if (!user) {
      (window as any).showToast?.('Please log in to add items to your wishlist');
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
          (window as any).showToast?.(data.inWishlist ? 'Added to wishlist!' : 'Removed from wishlist');
        } else {
          (window as any).showToast?.('Failed to update wishlist');
        }
      })
      .catch(function(err: unknown) {
        btn!.style.opacity = '1';
        btn!.style.pointerEvents = 'auto';
        log.error('Wishlist error:', err);
        (window as any).showToast?.('Failed to update wishlist');
      });
    } catch (err: unknown) {
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
      log.error('Auth error:', err);
      (window as any).showToast?.('Authentication error');
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

// ============================================
// PRE-ORDER SYSTEM
// ============================================
export function initPreorderSystem() {
  var preorderButtons = document.querySelectorAll('.preorder-btn');

  preorderButtons.forEach(function(btn) {
    btn.addEventListener('click', async function(e) {
      e.preventDefault();

      if (!(window as any).FreshWaxCart || !(window as any).FreshWaxCart.isLoggedIn()) {
        window.location.href = '/login/?redirect=' + encodeURIComponent(window.location.pathname);
        return;
      }

      var releaseId = (btn as HTMLElement).getAttribute('data-release-id');
      var title = (btn as HTMLElement).getAttribute('data-title');
      var artist = (btn as HTMLElement).getAttribute('data-artist');
      var artwork = (btn as HTMLElement).getAttribute('data-artwork');
      var price = parseFloat((btn as HTMLElement).getAttribute('data-price') || '0');
      var releaseDate = (btn as HTMLElement).getAttribute('data-release-date');

      var cart = (window as any).FreshWaxCart.get();
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

      (window as any).FreshWaxCart.save({ items: items });
      (window as any).FreshWaxCart.updateBadge();

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

// ============================================
// NYOP (Name Your Own Price) Modal System
// ============================================
var nyopModalInitialized = false;
var nyopCurrentReleaseData: any = null;

export function initNYOPSystem() {
  var modal = document.getElementById('nyop-modal');
  if (!modal) return;

  var modalArtwork = document.getElementById('nyop-modal-artwork') as HTMLImageElement;
  var modalTitle = document.getElementById('nyop-modal-title');
  var modalArtist = document.getElementById('nyop-modal-artist');
  var modalPrice = document.getElementById('nyop-modal-price') as HTMLInputElement;
  var modalMinText = document.getElementById('nyop-modal-min-text');
  var modalError = document.getElementById('nyop-modal-error') as HTMLElement;
  var modalAddCart = document.getElementById('nyop-modal-add-cart') as HTMLButtonElement;
  var quickPrices = modal.querySelectorAll('.nyop-quick-price');

  document.querySelectorAll('.nyop-open-modal').forEach(function(btn: Element) {
    if ((btn as HTMLElement).dataset.nyopInit === 'true') return;
    (btn as HTMLElement).dataset.nyopInit = 'true';

    btn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();

      var minPrice = parseFloat((btn as HTMLElement).dataset.nyopMin || '0') || 0;
      var suggestedPrice = parseFloat((btn as HTMLElement).dataset.nyopSuggested || '0') || minPrice || 5;

      nyopCurrentReleaseData = {
        releaseId: (btn as HTMLElement).dataset.releaseId,
        title: (btn as HTMLElement).dataset.title,
        artist: (btn as HTMLElement).dataset.artist,
        labelName: (btn as HTMLElement).dataset.labelName,
        artwork: (btn as HTMLElement).dataset.artwork,
        minPrice: minPrice,
        suggestedPrice: suggestedPrice,
        isPreorder: (btn as HTMLElement).dataset.isPreorder === 'true'
      };

      modalArtwork.src = nyopCurrentReleaseData.artwork || '/place-holder.webp';
      if (modalTitle) modalTitle.textContent = nyopCurrentReleaseData.title;
      if (modalArtist) modalArtist.textContent = nyopCurrentReleaseData.artist;
      modalPrice.value = suggestedPrice.toFixed(2);
      if (modalMinText) modalMinText.textContent = minPrice > 0
        ? '\u00a3' + minPrice.toFixed(2) + ' minimum'
        : 'Pay what you want (including \u00a30)';
      modalError.classList.add('hidden');

      updateQuickPriceButtons(suggestedPrice);

      nyopPreviousFocus = document.activeElement;
      modal!.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
      if (modalPrice) modalPrice.focus();
    });
  });

  if (nyopModalInitialized) return;
  nyopModalInitialized = true;

  var nyopPreviousFocus: Element | null = null;

  function closeModal() {
    modal!.classList.add('hidden');
    document.body.style.overflow = '';
    nyopCurrentReleaseData = null;
    if (nyopPreviousFocus && typeof (nyopPreviousFocus as HTMLElement).focus === 'function') {
      (nyopPreviousFocus as HTMLElement).focus();
      nyopPreviousFocus = null;
    }
  }

  modal.addEventListener('keydown', function(e: KeyboardEvent) {
    if (e.key !== 'Tab') return;
    var focusableEls = modal!.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusableEls.length === 0) return;
    var firstEl = focusableEls[0] as HTMLElement;
    var lastEl = focusableEls[focusableEls.length - 1] as HTMLElement;
    if (e.shiftKey) {
      if (document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      }
    } else {
      if (document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }
  });

  modal.querySelectorAll('[data-close-modal]').forEach(function(el) {
    el.addEventListener('click', closeModal);
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && !modal!.classList.contains('hidden')) {
      closeModal();
    }
  });

  quickPrices.forEach(function(btn: Element) {
    btn.addEventListener('click', function() {
      var price = parseFloat((btn as HTMLElement).dataset.price || '0') || 0;
      modalPrice.value = price.toFixed(2);
      updateQuickPriceButtons(price);
      validatePrice();
    });
  });

  function updateQuickPriceButtons(selectedPrice: number) {
    quickPrices.forEach(function(btn: Element) {
      var btnPrice = parseFloat((btn as HTMLElement).dataset.price || '0') || 0;
      if (btnPrice === selectedPrice) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  modalPrice.addEventListener('input', function() {
    validatePrice();
    quickPrices.forEach(function(b: Element) { b.classList.remove('active'); });
  });

  modalPrice.addEventListener('blur', function() {
    var value = parseFloat(modalPrice.value) || 0;
    var minPrice = nyopCurrentReleaseData ? nyopCurrentReleaseData.minPrice : 0;
    modalPrice.value = Math.max(minPrice, value).toFixed(2);
    validatePrice();
  });

  function validatePrice(): boolean {
    if (!nyopCurrentReleaseData) return true;

    var value = parseFloat(modalPrice.value) || 0;
    var minPrice = nyopCurrentReleaseData.minPrice || 0;

    if (value < minPrice) {
      modalError.textContent = 'Minimum price is \u00a3' + minPrice.toFixed(2);
      modalError.classList.remove('hidden');
      modalAddCart.disabled = true;
      modalAddCart.classList.add('opacity-50', 'cursor-not-allowed');
      return false;
    } else {
      modalError.classList.add('hidden');
      modalAddCart.disabled = false;
      modalAddCart.classList.remove('opacity-50', 'cursor-not-allowed');
      return true;
    }
  }

  modalAddCart.addEventListener('click', function() {
    if (!nyopCurrentReleaseData || !validatePrice()) return;

    var price = parseFloat(modalPrice.value) || 0;

    var tempBtn = document.createElement('button');
    tempBtn.className = 'add-to-cart hidden';
    tempBtn.dataset.releaseId = nyopCurrentReleaseData.releaseId;
    tempBtn.dataset.productType = 'digital';
    tempBtn.dataset.price = price.toFixed(2);
    tempBtn.dataset.title = nyopCurrentReleaseData.title;
    tempBtn.dataset.artist = nyopCurrentReleaseData.artist;
    tempBtn.dataset.labelName = nyopCurrentReleaseData.labelName || '';
    tempBtn.dataset.artwork = nyopCurrentReleaseData.artwork;
    tempBtn.dataset.isPreorder = nyopCurrentReleaseData.isPreorder ? 'true' : 'false';
    document.body.appendChild(tempBtn);
    tempBtn.click();
    setTimeout(function() { tempBtn.remove(); }, 100);

    closeModal();
  });
}
