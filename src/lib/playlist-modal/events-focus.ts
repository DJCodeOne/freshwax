// src/lib/playlist-modal/events-focus.ts
// Focus trap helpers for modal dialogs.

// Map to store focus trap handlers per element (avoids `as any` casts)
const focusTrapHandlers = new WeakMap<HTMLElement, (e: KeyboardEvent) => void>();

/** Focus trap helper for modal dialogs */
export function trapFocus(modalEl: HTMLElement): void {
  const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const focusableElements = modalEl.querySelectorAll<HTMLElement>(focusableSelector);
  if (focusableElements.length === 0) return;
  const firstFocusable = focusableElements[0];
  const lastFocusable = focusableElements[focusableElements.length - 1];

  const handler = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    if (e.shiftKey) {
      if (document.activeElement === firstFocusable) {
        e.preventDefault();
        lastFocusable.focus();
      }
    } else {
      if (document.activeElement === lastFocusable) {
        e.preventDefault();
        firstFocusable.focus();
      }
    }
  };
  focusTrapHandlers.set(modalEl, handler);
  modalEl.addEventListener('keydown', handler);
  firstFocusable.focus();
}

export function removeFocusTrap(modalEl: HTMLElement): void {
  const handler = focusTrapHandlers.get(modalEl);
  if (handler) {
    modalEl.removeEventListener('keydown', handler);
    focusTrapHandlers.delete(modalEl);
  }
}
