// src/lib/checkout/cart-validation.ts
// Price/stock validation, cart calculations, credit, and duplicate checking

import { TIMEOUTS } from '../timeouts';
import type { CheckoutState, DuplicateResult } from './types';

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
  } catch (e: unknown){
    state.logger.error('Cart parse error:', e);
    state.cart = [];
  }
  return state.cart;
}

export function calculateTotals(state: CheckoutState) {
  const subtotal = state.cart.reduce((sum: number, item: CartItem) => sum + (item.price * item.quantity), 0);
  const hasPhysicalItems = state.cart.some((item: CartItem) =>
    item.type === 'vinyl' || item.type === 'merch' || item.productType === 'vinyl' || item.productType === 'merch'
  );

  // Free orders: no shipping, no fees
  if (subtotal === 0) {
    return { subtotal: 0, shipping: 0, hasPhysicalItems, freshWaxFee: 0, stripeFee: 0, serviceFees: 0, total: 0 };
  }

  const shipping = hasPhysicalItems ? (subtotal >= 50 ? 0 : 4.99) : 0;

  // Bandcamp-style pricing: fees come OUT of the sale, not added on top
  // Customer pays exactly what's displayed (subtotal + shipping)
  // Fees are deducted from artist payout, not charged to customer
  const total = subtotal + shipping;

  // Calculate fees for backend/payout purposes (deducted from artist share)
  const freshWaxFee = subtotal * 0.01; // 1% Fresh Wax platform fee
  const stripeFee = (total * 0.014) + 0.20; // Stripe processing fee
  const serviceFees = freshWaxFee + stripeFee;

  return { subtotal, shipping, hasPhysicalItems, freshWaxFee, stripeFee, serviceFees, total };
}

export function getBadgeStyle(type: string): string {
  if (type === 'vinyl') return 'background: #000; color: #fff; border-color: #fff;';
  if (type === 'merch') return 'background: #1e1b4b; color: #a5b4fc; border-color: #a5b4fc;';
  return 'background: #052e16; color: #22c55e; border-color: #22c55e;';
}

// Check for duplicate audio purchases via API
export async function checkDuplicatePurchases(state: CheckoutState, userId: string) {
  if (!userId) return { duplicates: [], ownedReleases: [] };

  try {
    // Add timeout protection
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.API);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (state.currentUser && typeof state.currentUser.getIdToken === 'function') {
      try {
        const token = await state.currentUser.getIdToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;
      } catch (e: unknown){
        // Token retrieval failed — continue without auth
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
  } catch (e: unknown){
    if (e instanceof Error && e.name === 'AbortError') {
      state.logger.error('Duplicate check timed out');
    } else {
      state.logger.error('Error checking duplicate purchases:', e);
    }
    return { duplicates: [], ownedReleases: [] };
  }
}

// Remove duplicate items from cart
export function removeDuplicatesFromCart(state: CheckoutState, duplicates: DuplicateResult[]) {
  const customerId = getCustomerIdFromCookie();
  if (!customerId) return;

  const duplicateKeys = new Set(duplicates.map((d: DuplicateResult) => {
    const item = d.item;
    if (item.trackId) {
      return `${item.releaseId || item.productId || item.id}_${item.trackId}`;
    }
    return item.releaseId || item.productId || item.id;
  }));

  state.cart = state.cart.filter((item: CartItem) => {
    const key = item.trackId
      ? `${item.releaseId || item.productId || item.id}_${item.trackId}`
      : (item.releaseId || item.productId || item.id);
    return !duplicateKeys.has(key);
  });

  // Save updated cart
  try {
    const cartKey = 'freshwax_cart_' + customerId;
    localStorage.setItem(cartKey, JSON.stringify({ items: state.cart, updatedAt: Date.now() }));
  } catch (e: unknown){
    // localStorage may throw in Safari private browsing
  }

  // Dispatch cart update event
  window.dispatchEvent(new CustomEvent('cartUpdated', { detail: { count: state.cart.reduce((sum: number, item: CartItem) => sum + item.quantity, 0) } }));
}

// Load user's credit balance
export async function loadCreditBalance(state: CheckoutState) {
  if (!state.currentUser) {
    state.creditBalance = 0;
    state.creditExpiry = null;
    state.creditLoaded = true;
    return;
  }

  try {
    const idToken = await state.currentUser.getIdToken();

    // Add timeout to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.API);

    const response = await fetch('/api/giftcards/balance/', {
      headers: { 'Authorization': `Bearer ${idToken}` },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      if (data.success) {
        state.creditBalance = data.balance || 0;
        // Find the earliest expiry from transactions
        if (data.transactions && data.transactions.length > 0) {
          const activeTransactions = data.transactions.filter((t: { expiresAt?: string }) =>
            t.expiresAt && new Date(t.expiresAt) > new Date()
          );
          if (activeTransactions.length > 0) {
            state.creditExpiry = activeTransactions.reduce((earliest: Date | null, t: { expiresAt?: string }) => {
              const expiry = new Date(t.expiresAt!);
              return !earliest || expiry < earliest ? expiry : earliest;
            }, null);
          }
        }
      }
    }
  } catch (e: unknown){
    if (e instanceof Error && e.name === 'AbortError') {
      state.logger.error('Credit balance request timed out');
    } else {
      state.logger.error('Failed to load credit balance:', e);
    }
  }
  state.creditLoaded = true;
}

export async function loadCustomerData(state: CheckoutState, uid: string) {
  try {
    // Load via lightweight API instead of Firestore SDK (~80KB saved)
    const headers: Record<string, string> = {};
    try {
      const idToken = await state.currentUser?.getIdToken();
      if (idToken) headers['Authorization'] = `Bearer ${idToken}`;
    } catch (e: unknown){ /* token fetch failed, API will use cookie fallback */ }

    // Add timeout protection
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.API);

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
  } catch (e: unknown){
    if (e instanceof Error && e.name === 'AbortError') {
      state.logger.error('Customer data request timed out');
    } else {
      state.logger.error('Error loading customer data:', e);
    }
  }
  return null;
}

// Check if logged-in user is a customer (only customers can buy)
export async function checkUserType(state: CheckoutState, uid: string) {
  try {
    const _token = await state.currentUser?.getIdToken();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.API_EXTENDED);

    const response = await fetch('/api/get-user-type/?uid=' + uid, {
      headers: _token ? { 'Authorization': `Bearer ${_token}` } : {},
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error('Failed to check user type');
    }
    const data = await response.json();
    return data;
  } catch (e: unknown){
    if (e instanceof Error && e.name === 'AbortError') {
      state.logger.error('User type check timed out');
    } else {
      state.logger.error('Error checking user type:', e);
    }
    return { isCustomer: false, isArtist: false };
  }
}
