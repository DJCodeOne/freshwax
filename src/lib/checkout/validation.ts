/**
 * Checkout validation — field validation, duplicate checks, price/totals calculation.
 */
import { createClientLogger } from '../client-logger';
import type { CheckoutState } from './state';

const logger = createClientLogger('Checkout');

/**
 * Type-safe form field value accessor.
 * Retrieves the value of a named form element without `as any` casts.
 */
export function getFormFieldValue(form: HTMLFormElement, name: string): string {
  const el = form.elements.namedItem(name);
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    return el.value;
  }
  return '';
}

/**
 * Type-safe form field checked accessor (for checkboxes).
 */
export function getFormFieldChecked(form: HTMLFormElement, name: string): boolean {
  const el = form.elements.namedItem(name);
  if (el instanceof HTMLInputElement) {
    return el.checked;
  }
  return false;
}

// ============================================
// FIELD VALIDATION
// ============================================

export function showError(message: string) {
  const errorMsg = document.getElementById('error-message');
  if (errorMsg) {
    errorMsg.textContent = message;
    errorMsg.style.display = 'block';
    setTimeout(() => {
      if (errorMsg.textContent === message) {
        errorMsg.style.display = 'none';
      }
    }, 10000);
    errorMsg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

export function hideError() {
  const errorMsg = document.getElementById('error-message');
  if (errorMsg) {
    errorMsg.style.display = 'none';
  }
}

export function validateField(input: HTMLInputElement | null): boolean {
  if (!input) return true;
  var errorSpan = document.getElementById(input.id + '-error');
  if (!input.checkValidity()) {
    input.setAttribute('aria-invalid', 'true');
    if (errorSpan) errorSpan.style.display = 'block';
    return false;
  } else {
    input.removeAttribute('aria-invalid');
    if (errorSpan) errorSpan.style.display = 'none';
    return true;
  }
}

export function validateAllFields(): boolean {
  var fieldIds = ['firstName', 'lastName', 'email', 'address1', 'city', 'postcode'];
  var allValid = true;
  for (var i = 0; i < fieldIds.length; i++) {
    var el = document.getElementById(fieldIds[i]) as HTMLInputElement | null;
    if (el && !validateField(el)) allValid = false;
  }
  return allValid;
}

export function setupFieldValidation() {
  var fieldIds = ['firstName', 'lastName', 'email', 'address1', 'city', 'postcode'];
  for (var i = 0; i < fieldIds.length; i++) {
    var el = document.getElementById(fieldIds[i]);
    if (el) {
      el.addEventListener('blur', function() { validateField(this as HTMLInputElement); });
      el.addEventListener('input', function() {
        if ((this as HTMLElement).getAttribute('aria-invalid') === 'true') {
          validateField(this as HTMLInputElement);
        }
      });
    }
  }
}

// ============================================
// CART & TOTALS
// ============================================

export function getCustomerIdFromCookie(): string | null {
  const cookies = document.cookie.split(';');
  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split('=');
    if (name === 'customerId' && value) {
      return value;
    }
  }
  return null;
}

export function loadCart(state: CheckoutState): CartItem[] {
  try {
    const customerId = getCustomerIdFromCookie();
    if (!customerId) {
      state.cart = [];
      return state.cart;
    }

    const cartKey = 'freshwax_cart_' + customerId;
    const stored = localStorage.getItem(cartKey);
    if (stored) {
      const parsed = JSON.parse(stored);
      state.cart = parsed.items ? parsed.items : (Array.isArray(parsed) ? parsed : []);
    } else {
      state.cart = [];
    }
  } catch (e: unknown) {
    logger.error('Cart parse error:', e);
    state.cart = [];
  }
  return state.cart;
}

export function calculateTotals(cart: CartItem[]) {
  const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const hasPhysicalItems = cart.some((item) =>
    item.type === 'vinyl' || item.type === 'merch' || item.productType === 'vinyl' || item.productType === 'merch'
  );

  if (subtotal === 0) {
    return { subtotal: 0, shipping: 0, hasPhysicalItems, freshWaxFee: 0, stripeFee: 0, serviceFees: 0, total: 0 };
  }

  const shipping = hasPhysicalItems ? (subtotal >= 50 ? 0 : 4.99) : 0;
  const total = subtotal + shipping;
  const freshWaxFee = subtotal * 0.01;
  const stripeFee = (total * 0.014) + 0.20;
  const serviceFees = freshWaxFee + stripeFee;

  return { subtotal, shipping, hasPhysicalItems, freshWaxFee, stripeFee, serviceFees, total };
}

// ============================================
// DUPLICATE PURCHASE CHECK
// ============================================

export async function checkDuplicatePurchases(state: CheckoutState, userId: string) {
  if (!userId) return { duplicates: [], ownedReleases: [] };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (state.currentUser && typeof state.currentUser.getIdToken === 'function') {
      try {
        const token = await state.currentUser.getIdToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;
      } catch (e: unknown) {
        // Token retrieval failed - continue without auth
      }
    }

    const response = await fetch('/api/check-duplicates/', {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId, cartItems: state.cart }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error('Failed to check duplicates');
    }

    const data = await response.json();
    return data;
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') {
      logger.error('Duplicate check timed out');
    } else {
      logger.error('Error checking duplicate purchases:', e);
    }
    return { duplicates: [], ownedReleases: [] };
  }
}

export function removeDuplicatesFromCart(state: CheckoutState, duplicates: DuplicatePurchase[]) {
  const customerId = getCustomerIdFromCookie();
  if (!customerId) return;

  const duplicateKeys = new Set(duplicates.map((d) => {
    const item = d.item;
    if (item.trackId) {
      return `${item.releaseId || item.productId || item.id}_${item.trackId}`;
    }
    return item.releaseId || item.productId || item.id;
  }));

  state.cart = state.cart.filter((item) => {
    const key = item.trackId
      ? `${item.releaseId || item.productId || item.id}_${item.trackId}`
      : (item.releaseId || item.productId || item.id);
    return !duplicateKeys.has(key);
  });

  try {
    const cartKey = 'freshwax_cart_' + customerId;
    localStorage.setItem(cartKey, JSON.stringify({ items: state.cart, updatedAt: Date.now() }));
  } catch (e: unknown) {
    // localStorage may throw in Safari private browsing
  }

  window.dispatchEvent(new CustomEvent('cartUpdated', { detail: { count: state.cart.reduce((sum, item) => sum + item.quantity, 0) } }));
}

// ============================================
// CUSTOMER DATA & CREDIT
// ============================================

export async function loadCustomerData(state: CheckoutState, uid: string) {
  try {
    const headers: Record<string, string> = {};
    try {
      const idToken = await state.currentUser?.getIdToken();
      if (idToken) headers['Authorization'] = `Bearer ${idToken}`;
    } catch (e: unknown) { /* token fetch failed, API will use cookie fallback */ }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch('/api/checkout-data/', {
      headers,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      if (data.success && data.customer) {
        return data.customer;
      }
    }
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') {
      logger.error('Customer data request timed out');
    } else {
      logger.error('Error loading customer data:', e);
    }
  }
  return null;
}

export async function loadCreditBalance(state: CheckoutState) {
  if (!state.currentUser) {
    state.creditBalance = 0;
    state.creditExpiry = null;
    state.creditLoaded = true;
    return;
  }

  try {
    const idToken = await state.currentUser.getIdToken();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch('/api/giftcards/balance/', {
      headers: { 'Authorization': `Bearer ${idToken}` },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      if (data.success) {
        state.creditBalance = data.balance || 0;
        if (data.transactions && data.transactions.length > 0) {
          const activeTransactions = data.transactions.filter((t: CreditTransaction) =>
            t.expiresAt && new Date(t.expiresAt) > new Date()
          );
          if (activeTransactions.length > 0) {
            state.creditExpiry = activeTransactions.reduce((earliest: Date | null, t: CreditTransaction) => {
              const expiry = new Date(t.expiresAt);
              return !earliest || expiry < earliest ? expiry : earliest;
            }, null as Date | null);
          }
        }
      }
    }
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') {
      logger.error('Credit balance request timed out');
    } else {
      logger.error('Failed to load credit balance:', e);
    }
  }
  state.creditLoaded = true;
}

export async function checkUserType(state: CheckoutState, uid: string) {
  try {
    const _token = await state.currentUser?.getIdToken();
    const response = await fetch('/api/get-user-type/?uid=' + uid, {
      headers: _token ? { 'Authorization': `Bearer ${_token}` } : {}
    });
    if (!response.ok) {
      throw new Error('Failed to check user type');
    }
    const data = await response.json();
    return data;
  } catch (e: unknown) {
    logger.error('Error checking user type:', e);
    return { isCustomer: false, isArtist: false };
  }
}
