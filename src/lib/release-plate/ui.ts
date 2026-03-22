/**
 * Release plate UI — cart functionality (add to cart, buy track), share system.
 */
import { createClientLogger } from '../client-logger';
import { FWCache } from './cache';

const log = createClientLogger('ReleasePlate');

declare function showToast(msg: string): void;

// ============================================
// SHARE SYSTEM
// ============================================
export var shareInitialized = false;

export function resetShareInit() {
  shareInitialized = false;
}

export function initShareSystem() {
  if (shareInitialized) return;
  shareInitialized = true;

  var shareModal = document.getElementById('share-modal');
  var shareModalClose = document.getElementById('share-modal-close');
  var shareModalBackdrop = document.getElementById('share-modal-backdrop');
  var shareUrlInput = document.getElementById('share-url-input') as HTMLInputElement | null;
  var copyUrlButton = document.getElementById('copy-url-button');
  var copyFeedback = document.getElementById('copy-feedback');
  var copyBtnText = document.getElementById('copy-btn-text');
  var shareModalTitle = document.getElementById('share-modal-title');
  var shareModalArtist = document.getElementById('share-modal-artist');
  var shareModalArtwork = document.getElementById('share-modal-artwork') as HTMLImageElement | null;

  if (!shareModal) return;

  var previousFocus: Element | null = null;

  (window as any).currentReleaseShareData = {};

  document.querySelectorAll('.share-button').forEach(function(button) {
    (button as HTMLElement).onclick = function() {
      var releaseId = button.getAttribute('data-release-id');
      var title = button.getAttribute('data-title');
      var artist = button.getAttribute('data-artist');
      var artwork = button.getAttribute('data-artwork') || '/place-holder.webp';
      var url = window.location.origin + '/item/' + releaseId;

      (window as any).currentReleaseShareData = { title: title, artist: artist, url: url, artwork: artwork };

      if (shareModalTitle) shareModalTitle.textContent = title;
      if (shareModalArtist) shareModalArtist.textContent = artist;
      if (shareModalArtwork) shareModalArtwork.src = artwork;
      if (shareUrlInput) shareUrlInput.value = url;
      if (copyFeedback) copyFeedback.classList.add('hidden');

      var nativeShareBtn = document.getElementById('native-share-btn');
      if (navigator.share && nativeShareBtn) {
        nativeShareBtn.classList.remove('hidden');
        nativeShareBtn.classList.add('flex');
      }

      previousFocus = document.activeElement;
      shareModal!.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
      if (shareModalClose) shareModalClose.focus();
    };
  });

  function closeModal() {
    shareModal!.classList.add('hidden');
    document.body.style.overflow = '';
    if (previousFocus && typeof (previousFocus as HTMLElement).focus === 'function') {
      (previousFocus as HTMLElement).focus();
      previousFocus = null;
    }
  }

  shareModal.addEventListener('keydown', function(e) {
    if (e.key !== 'Tab') return;
    var focusableEls = shareModal!.querySelectorAll(
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

  if (shareModalClose) (shareModalClose as HTMLElement).onclick = closeModal;
  if (shareModalBackdrop) (shareModalBackdrop as HTMLElement).onclick = closeModal;

  if (copyUrlButton) {
    (copyUrlButton as HTMLElement).onclick = function() {
      navigator.clipboard.writeText(shareUrlInput!.value)
        .then(function() {
          if (copyBtnText) copyBtnText.textContent = 'Copied!';
          if (copyFeedback) copyFeedback.classList.remove('hidden');
          setTimeout(function() {
            if (copyBtnText) copyBtnText.textContent = 'Copy';
            if (copyFeedback) copyFeedback.classList.add('hidden');
          }, 2000);
        })
        .catch(function() {
          if (copyFeedback) {
            copyFeedback.textContent = 'Failed to copy';
            copyFeedback.classList.remove('hidden');
          }
        });
    };
  }

  // Social share buttons
  document.getElementById('share-twitter')?.addEventListener('click', function() {
    var d = (window as any).currentReleaseShareData || {};
    var text = 'Check out "' + d.title + '" by ' + d.artist + ' on Fresh Wax';
    window.open('https://x.com/intent/tweet?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(d.url), '_blank', 'noopener,noreferrer,width=550,height=420');
  });

  document.getElementById('share-facebook')?.addEventListener('click', function() {
    var d = (window as any).currentReleaseShareData || {};
    window.open('https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(d.url), '_blank', 'noopener,noreferrer,width=550,height=420');
  });

  document.getElementById('share-whatsapp')?.addEventListener('click', function() {
    var d = (window as any).currentReleaseShareData || {};
    var text = 'Check out "' + d.title + '" by ' + d.artist + ' on Fresh Wax ' + d.url;
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener,noreferrer');
  });

  document.getElementById('share-instagram')?.addEventListener('click', function() {
    var d = (window as any).currentReleaseShareData || {};
    var text = d.url;
    navigator.clipboard.writeText(text).then(function() {
      alert('Link copied! Paste it in your Instagram story or bio.');
    });
  });

  document.getElementById('share-reddit')?.addEventListener('click', function() {
    var d = (window as any).currentReleaseShareData || {};
    var title = d.title + ' by ' + d.artist + ' - Fresh Wax';
    window.open('https://www.reddit.com/submit?url=' + encodeURIComponent(d.url) + '&title=' + encodeURIComponent(title), '_blank', 'noopener,noreferrer,width=550,height=420');
  });

  document.getElementById('native-share-btn')?.addEventListener('click', async function() {
    var d = (window as any).currentReleaseShareData || {};
    try {
      await navigator.share({
        title: d.title + ' by ' + d.artist,
        text: 'Check out this release on Fresh Wax',
        url: d.url
      });
    } catch (err: unknown) {
      // Share cancelled or failed
    }
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && !shareModal!.classList.contains('hidden')) {
      closeModal();
    }
  });
}

// ============================================
// CART FUNCTIONALITY - EVENT DELEGATION
// ============================================
export function initCartListeners() {
  if ((window as any).cartListenersAttached) return;
  (window as any).cartListenersAttached = true;

  // Add to cart (digital/vinyl releases)
  document.addEventListener('click', async function(e) {
    var button = (e.target as HTMLElement).closest('.add-to-cart') as HTMLElement | null;
    if (!button || button.hasAttribute('disabled')) return;

    e.preventDefault();

    if (!(window as any).FreshWaxCart || !(window as any).FreshWaxCart.isLoggedIn()) {
      window.location.href = '/login/?redirect=' + encodeURIComponent(window.location.pathname);
      return;
    }

    var releaseId = button.getAttribute('data-release-id');
    var productType = button.getAttribute('data-product-type');
    var price = parseFloat(button.getAttribute('data-price') || '0');
    var title = button.getAttribute('data-title');
    var artist = button.getAttribute('data-artist');
    var labelName = button.getAttribute('data-label-name');
    var artwork = button.getAttribute('data-artwork');

    // Check if user already owns this release
    try {
      var userId: string | null = null;
      if ((window as any).firebaseAuth && (window as any).firebaseAuth.currentUser) {
        userId = (window as any).firebaseAuth.currentUser.uid;
      }

      if (userId) {
        var ownershipCache = FWCache.get('ownership_' + userId) || {};
        var cachedOwnership = ownershipCache[releaseId!];

        if (!cachedOwnership) {
          var _token = (window as any).firebaseAuth?.currentUser ? await (window as any).firebaseAuth.currentUser.getIdToken() : null;
          var _headers: Record<string, string> = _token ? { 'Authorization': 'Bearer ' + _token } : {};
          var checkRes = await fetch('/api/check-ownership/?userId=' + userId + '&releaseId=' + releaseId, { headers: _headers });
          if (!checkRes.ok) { cachedOwnership = {}; } else { cachedOwnership = await checkRes.json(); }
          ownershipCache[releaseId!] = cachedOwnership;
          FWCache.set('ownership_' + userId, ownershipCache, FWCache.TTL.OWNERSHIP);
        }

        if (cachedOwnership.ownsFullRelease) {
          showToast('You already own this release! Check your order history for download links.');
          return;
        }
      }
    } catch (err: unknown) {
      log.warn('Ownership check failed:', err);
    }

    var cart = (window as any).FreshWaxCart.get();
    var items = cart.items || [];

    if (productType === 'vinyl') {
      items = items.filter(function(item: any) {
        return !(item.id === releaseId && item.type === 'digital');
      });
    }

    if (productType === 'digital' || productType === 'vinyl') {
      var removedTracks = items.filter(function(item: any) {
        return item.id === releaseId && item.type === 'track';
      });

      if (removedTracks.length > 0) {
        items = items.filter(function(item: any) {
          return !(item.id === releaseId && item.type === 'track');
        });
      }
    }

    var existingIndex = -1;
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === releaseId && items[i].type === productType) {
        existingIndex = i;
        break;
      }
    }

    if (existingIndex !== -1) {
      items[existingIndex].quantity = (items[existingIndex].quantity || 1) + 1;
    } else {
      items.push({
        id: releaseId,
        releaseId: releaseId,
        type: productType,
        format: productType,
        name: artist + ' - ' + title,
        title: title,
        artist: artist,
        labelName: labelName,
        price: price,
        image: artwork,
        artwork: artwork,
        quantity: 1
      });
    }

    (window as any).FreshWaxCart.save({ items: items });
    (window as any).FreshWaxCart.updateBadge();

    var originalHTML = button.innerHTML;
    button.innerHTML = '<span>\u2713 Added!</span>';
    button.classList.add('bg-green-700');

    setTimeout(function() {
      button!.innerHTML = originalHTML;
      button!.classList.remove('bg-green-700');
    }, 1500);
  });

  // Buy individual track
  document.addEventListener('click', async function(e) {
    var button = (e.target as HTMLElement).closest('.buy-track') as HTMLElement | null;
    if (!button) return;

    e.preventDefault();

    if (!(window as any).FreshWaxCart || !(window as any).FreshWaxCart.isLoggedIn()) {
      window.location.href = '/login/?redirect=' + encodeURIComponent(window.location.pathname);
      return;
    }

    var trackId = button.getAttribute('data-track-id');
    var trackTitle = button.getAttribute('data-track-title');
    var trackPrice = parseFloat(button.getAttribute('data-track-price') || '0');
    var releaseId = button.getAttribute('data-release-id');
    var artist = button.getAttribute('data-artist');
    var artwork = button.getAttribute('data-artwork');

    var cart = (window as any).FreshWaxCart.get();
    var items = cart.items || [];

    var hasFullRelease = items.some(function(item: any) {
      return item.id === releaseId && (item.type === 'digital' || item.type === 'vinyl');
    });

    if (hasFullRelease) {
      showToast('You already have the full release in your cart! No need to buy individual tracks.');
      return;
    }

    var hasTrack = items.some(function(item: any) {
      return item.id === releaseId && item.trackId === trackId;
    });

    if (hasTrack) {
      showToast('This track is already in your cart!');
      return;
    }

    // Check if user already owns this release or track
    try {
      var userId: string | null = null;
      if ((window as any).firebaseAuth && (window as any).firebaseAuth.currentUser) {
        userId = (window as any).firebaseAuth.currentUser.uid;
      }

      if (userId) {
        var ownershipCache = FWCache.get('ownership_' + userId) || {};
        var cachedOwnership = ownershipCache[releaseId!];

        if (!cachedOwnership) {
          var _token2 = (window as any).firebaseAuth?.currentUser ? await (window as any).firebaseAuth.currentUser.getIdToken() : null;
          var _headers2: Record<string, string> = _token2 ? { 'Authorization': 'Bearer ' + _token2 } : {};
          var checkRes = await fetch('/api/check-ownership/?userId=' + userId + '&releaseId=' + releaseId + '&trackId=' + trackId, { headers: _headers2 });
          if (!checkRes.ok) { cachedOwnership = {}; } else { cachedOwnership = await checkRes.json(); }
          ownershipCache[releaseId!] = cachedOwnership;
          FWCache.set('ownership_' + userId, ownershipCache, FWCache.TTL.OWNERSHIP);
        }

        if (cachedOwnership.ownsFullRelease) {
          alert('You already own the full release that includes this track! Check your order history for download links.');
          return;
        }

        var ownsThisTrack = cachedOwnership.ownedTrackIds && cachedOwnership.ownedTrackIds.indexOf(trackId) !== -1;
        if (ownsThisTrack) {
          alert('You already own this track! Check your order history for download links.');
          return;
        }
      }
    } catch (err: unknown) {
      log.warn('Track ownership check failed:', err);
    }

    items.push({
      id: releaseId,
      releaseId: releaseId,
      trackId: trackId,
      type: 'track',
      format: 'track',
      name: artist + ' - ' + trackTitle,
      title: trackTitle,
      artist: artist,
      price: trackPrice,
      image: artwork,
      artwork: artwork,
      quantity: 1
    });

    (window as any).FreshWaxCart.save({ items: items });
    (window as any).FreshWaxCart.updateBadge();

    var originalHTML = button.innerHTML;
    button.innerHTML = '\u2713';
    button.classList.add('bg-green-700');

    setTimeout(function() {
      button!.innerHTML = originalHTML;
      button!.classList.remove('bg-green-700');
    }, 1500);
  });
}
