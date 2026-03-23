/**
 * Release plate — NYOP (Name Your Own Price) modal system.
 * Extracted from api.ts for focused module organization.
 */
import { TIMEOUTS } from '../timeouts';

// ============================================
// NYOP (Name Your Own Price) Modal System
// ============================================
var nyopModalInitialized = false;
var nyopCurrentReleaseData: NyopReleaseData | null = null;

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
    setTimeout(function() { tempBtn.remove(); }, TIMEOUTS.POLL);

    closeModal();
  });
}
