import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CheckoutState } from '../lib/checkout/types';
import type { ClientLogger } from '../lib/client-logger';

// Mock localStorage and document.cookie before importing the module
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
    get _store() { return store; },
  };
})();

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });
Object.defineProperty(globalThis, 'window', {
  value: {
    dispatchEvent: vi.fn(),
    CustomEvent: class CustomEvent {
      type: string;
      detail: unknown;
      constructor(type: string, opts?: { detail?: unknown }) {
        this.type = type;
        this.detail = opts?.detail;
      }
    },
  },
  writable: true,
});
Object.defineProperty(globalThis, 'CustomEvent', {
  value: (globalThis as unknown as { window: { CustomEvent: unknown } }).window.CustomEvent,
  writable: true,
});

// Must set document.cookie before importing — module reads it at call time
let cookieValue = '';
Object.defineProperty(globalThis, 'document', {
  value: {
    get cookie() { return cookieValue; },
    set cookie(v: string) { cookieValue = v; },
  },
  writable: true,
});

import {
  getCustomerIdFromCookie,
  loadCart,
  calculateTotals,
  getBadgeStyle,
  removeDuplicatesFromCart,
} from '../lib/checkout/cart-validation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeLogger(): ClientLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeState(overrides: Partial<CheckoutState> = {}): CheckoutState {
  return {
    currentUser: null,
    customerData: null,
    cart: [],
    creditBalance: 0,
    creditExpiry: null,
    appliedCredit: 0,
    creditLoaded: false,
    selectedPaymentMethod: '',
    paypalButtonsRendered: false,
    userTypeChecked: false,
    isAllowedToBuy: false,
    duplicatePurchases: [],
    authInitialized: false,
    logger: makeLogger(),
    ...overrides,
  };
}

function makeItem(overrides: Partial<CartItem> = {}): CartItem {
  return {
    name: 'Test Item',
    price: 9.99,
    quantity: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  localStorageMock.clear();
  cookieValue = '';
  vi.clearAllMocks();
});

// =============================================
// getCustomerIdFromCookie
// =============================================
describe('getCustomerIdFromCookie', () => {
  it('returns null when no cookies are set', () => {
    cookieValue = '';
    expect(getCustomerIdFromCookie()).toBeNull();
  });

  it('returns the customerId value when present', () => {
    cookieValue = 'customerId=abc123';
    expect(getCustomerIdFromCookie()).toBe('abc123');
  });

  it('finds customerId among multiple cookies', () => {
    cookieValue = 'theme=dark; customerId=user42; lang=en';
    expect(getCustomerIdFromCookie()).toBe('user42');
  });

  it('returns null when customerId cookie has empty value', () => {
    cookieValue = 'customerId=';
    expect(getCustomerIdFromCookie()).toBeNull();
  });

  it('returns null when other cookies exist but not customerId', () => {
    cookieValue = 'session=xyz; theme=dark';
    expect(getCustomerIdFromCookie()).toBeNull();
  });
});

// =============================================
// loadCart
// =============================================
describe('loadCart', () => {
  it('returns empty array when no customerId cookie', () => {
    cookieValue = '';
    const state = makeState();
    const result = loadCart(state);
    expect(result).toEqual([]);
    expect(state.cart).toEqual([]);
  });

  it('returns empty array when localStorage has no cart key', () => {
    cookieValue = 'customerId=user1';
    const state = makeState();
    const result = loadCart(state);
    expect(result).toEqual([]);
    expect(state.cart).toEqual([]);
  });

  it('loads cart from { items: [...] } format', () => {
    cookieValue = 'customerId=user1';
    const items = [makeItem({ name: 'Track A', price: 5 })];
    localStorageMock.setItem('freshwax_cart_user1', JSON.stringify({ items }));
    const state = makeState();
    const result = loadCart(state);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Track A');
  });

  it('loads cart from raw array format (legacy)', () => {
    cookieValue = 'customerId=user1';
    const items = [makeItem({ name: 'Track B' })];
    localStorageMock.setItem('freshwax_cart_user1', JSON.stringify(items));
    const state = makeState();
    const result = loadCart(state);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Track B');
  });

  it('returns empty array for non-object/non-array stored value', () => {
    cookieValue = 'customerId=user1';
    localStorageMock.setItem('freshwax_cart_user1', JSON.stringify('just a string'));
    const state = makeState();
    const result = loadCart(state);
    expect(result).toEqual([]);
  });

  it('returns empty array and logs error for corrupted JSON', () => {
    cookieValue = 'customerId=user1';
    localStorageMock.setItem('freshwax_cart_user1', '{invalid json!!!');
    const state = makeState();
    const result = loadCart(state);
    expect(result).toEqual([]);
    expect(state.logger.error).toHaveBeenCalledWith('Cart parse error:', expect.any(SyntaxError));
  });
});

// =============================================
// calculateTotals
// =============================================
describe('calculateTotals', () => {
  it('returns all zeros for empty cart', () => {
    const state = makeState({ cart: [] });
    const totals = calculateTotals(state);
    expect(totals.subtotal).toBe(0);
    expect(totals.shipping).toBe(0);
    expect(totals.total).toBe(0);
    expect(totals.freshWaxFee).toBe(0);
    expect(totals.stripeFee).toBe(0);
    expect(totals.serviceFees).toBe(0);
    expect(totals.hasPhysicalItems).toBe(false);
  });

  it('calculates digital-only cart with no shipping', () => {
    const state = makeState({
      cart: [makeItem({ type: 'digital', price: 10, quantity: 1 })],
    });
    const totals = calculateTotals(state);
    expect(totals.subtotal).toBe(10);
    expect(totals.shipping).toBe(0);
    expect(totals.hasPhysicalItems).toBe(false);
    expect(totals.total).toBe(10);
  });

  it('adds shipping for vinyl under 50 threshold', () => {
    const state = makeState({
      cart: [makeItem({ type: 'vinyl', price: 20, quantity: 1 })],
    });
    const totals = calculateTotals(state);
    expect(totals.subtotal).toBe(20);
    expect(totals.shipping).toBe(4.99);
    expect(totals.hasPhysicalItems).toBe(true);
    expect(totals.total).toBeCloseTo(24.99, 2);
  });

  it('gives free shipping for physical items at exactly 50', () => {
    const state = makeState({
      cart: [makeItem({ type: 'vinyl', price: 50, quantity: 1 })],
    });
    const totals = calculateTotals(state);
    expect(totals.shipping).toBe(0);
    expect(totals.total).toBe(50);
  });

  it('gives free shipping for physical items over 50', () => {
    const state = makeState({
      cart: [makeItem({ type: 'merch', price: 25, quantity: 3 })],
    });
    const totals = calculateTotals(state);
    expect(totals.subtotal).toBe(75);
    expect(totals.shipping).toBe(0);
    expect(totals.total).toBe(75);
  });

  it('detects physical items via productType field', () => {
    const state = makeState({
      cart: [makeItem({ productType: 'vinyl', price: 15, quantity: 1 })],
    });
    const totals = calculateTotals(state);
    expect(totals.hasPhysicalItems).toBe(true);
    expect(totals.shipping).toBe(4.99);
  });

  it('detects physical items via productType merch', () => {
    const state = makeState({
      cart: [makeItem({ productType: 'merch', price: 15, quantity: 1 })],
    });
    const totals = calculateTotals(state);
    expect(totals.hasPhysicalItems).toBe(true);
  });

  it('handles mixed digital and physical items', () => {
    const state = makeState({
      cart: [
        makeItem({ type: 'digital', price: 5, quantity: 2 }),
        makeItem({ type: 'vinyl', price: 12, quantity: 1 }),
      ],
    });
    const totals = calculateTotals(state);
    expect(totals.subtotal).toBe(22);
    expect(totals.hasPhysicalItems).toBe(true);
    expect(totals.shipping).toBe(4.99);
    expect(totals.total).toBeCloseTo(26.99, 2);
  });

  it('calculates fees correctly (bandcamp-style deducted from artist)', () => {
    const state = makeState({
      cart: [makeItem({ type: 'digital', price: 100, quantity: 1 })],
    });
    const totals = calculateTotals(state);
    // freshWaxFee = 100 * 0.01 = 1
    expect(totals.freshWaxFee).toBe(1);
    // stripeFee = (100 * 0.014) + 0.20 = 1.40 + 0.20 = 1.60
    expect(totals.stripeFee).toBeCloseTo(1.60, 2);
    // serviceFees = 1 + 1.60 = 2.60
    expect(totals.serviceFees).toBeCloseTo(2.60, 2);
    // total = subtotal only (fees NOT added to customer)
    expect(totals.total).toBe(100);
  });

  it('sums quantities correctly', () => {
    const state = makeState({
      cart: [makeItem({ type: 'digital', price: 3, quantity: 4 })],
    });
    const totals = calculateTotals(state);
    expect(totals.subtotal).toBe(12);
  });

  it('returns all zeros for free items (subtotal 0)', () => {
    const state = makeState({
      cart: [makeItem({ type: 'digital', price: 0, quantity: 5 })],
    });
    const totals = calculateTotals(state);
    expect(totals.subtotal).toBe(0);
    expect(totals.shipping).toBe(0);
    expect(totals.total).toBe(0);
    expect(totals.freshWaxFee).toBe(0);
    expect(totals.stripeFee).toBe(0);
  });
});

// =============================================
// getBadgeStyle
// =============================================
describe('getBadgeStyle', () => {
  it('returns black/white for vinyl', () => {
    const style = getBadgeStyle('vinyl');
    expect(style).toContain('background: #000');
    expect(style).toContain('color: #fff');
  });

  it('returns indigo for merch', () => {
    const style = getBadgeStyle('merch');
    expect(style).toContain('background: #1e1b4b');
    expect(style).toContain('color: #a5b4fc');
  });

  it('returns green for digital/default', () => {
    const style = getBadgeStyle('digital');
    expect(style).toContain('background: #052e16');
    expect(style).toContain('color: #22c55e');
  });

  it('returns green for unknown type', () => {
    const style = getBadgeStyle('unknown-type');
    expect(style).toContain('background: #052e16');
  });

  it('returns green for empty string', () => {
    const style = getBadgeStyle('');
    expect(style).toContain('background: #052e16');
  });
});

// =============================================
// removeDuplicatesFromCart
// =============================================
describe('removeDuplicatesFromCart', () => {
  it('does nothing when no customerId cookie', () => {
    cookieValue = '';
    const state = makeState({
      cart: [makeItem({ id: 'r1', name: 'Release 1' })],
    });
    removeDuplicatesFromCart(state, [{ item: makeItem({ id: 'r1' }), reason: 'already owned' }]);
    // Cart unchanged since function returns early
    expect(state.cart).toHaveLength(1);
  });

  it('removes duplicate items matched by id', () => {
    cookieValue = 'customerId=user1';
    const state = makeState({
      cart: [
        makeItem({ id: 'r1', name: 'Release 1' }),
        makeItem({ id: 'r2', name: 'Release 2' }),
      ],
    });
    removeDuplicatesFromCart(state, [{ item: makeItem({ id: 'r1' }), reason: 'already owned' }]);
    expect(state.cart).toHaveLength(1);
    expect(state.cart[0].name).toBe('Release 2');
  });

  it('removes duplicate items matched by releaseId', () => {
    cookieValue = 'customerId=user1';
    const state = makeState({
      cart: [
        makeItem({ releaseId: 'rel-1', name: 'R1' }),
        makeItem({ releaseId: 'rel-2', name: 'R2' }),
      ],
    });
    removeDuplicatesFromCart(state, [
      { item: makeItem({ releaseId: 'rel-1' }), reason: 'owned' },
    ]);
    expect(state.cart).toHaveLength(1);
    expect(state.cart[0].name).toBe('R2');
  });

  it('removes track-level duplicates using releaseId_trackId key', () => {
    cookieValue = 'customerId=user1';
    const state = makeState({
      cart: [
        makeItem({ releaseId: 'rel-1', trackId: 't1', name: 'Track 1' }),
        makeItem({ releaseId: 'rel-1', trackId: 't2', name: 'Track 2' }),
      ],
    });
    removeDuplicatesFromCart(state, [
      { item: makeItem({ releaseId: 'rel-1', trackId: 't1' }), reason: 'already owned' },
    ]);
    expect(state.cart).toHaveLength(1);
    expect(state.cart[0].name).toBe('Track 2');
  });

  it('saves updated cart to localStorage after removal', () => {
    cookieValue = 'customerId=user1';
    const state = makeState({
      cart: [
        makeItem({ id: 'r1', name: 'Release 1' }),
        makeItem({ id: 'r2', name: 'Release 2' }),
      ],
    });
    removeDuplicatesFromCart(state, [{ item: makeItem({ id: 'r1' }), reason: 'owned' }]);
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'freshwax_cart_user1',
      expect.stringContaining('"items"'),
    );
    // Verify stored data has only remaining item
    const stored = JSON.parse(localStorageMock.setItem.mock.calls[0][1]);
    expect(stored.items).toHaveLength(1);
    expect(stored.items[0].id).toBe('r2');
    expect(stored.updatedAt).toBeTypeOf('number');
  });

  it('dispatches cartUpdated event with new count', () => {
    cookieValue = 'customerId=user1';
    const state = makeState({
      cart: [
        makeItem({ id: 'r1', quantity: 1 }),
        makeItem({ id: 'r2', quantity: 3 }),
      ],
    });
    removeDuplicatesFromCart(state, [{ item: makeItem({ id: 'r1' }), reason: 'owned' }]);
    expect((globalThis as unknown as { window: { dispatchEvent: ReturnType<typeof vi.fn> } }).window.dispatchEvent).toHaveBeenCalledTimes(1);
    const event = (globalThis as unknown as { window: { dispatchEvent: ReturnType<typeof vi.fn> } }).window.dispatchEvent.mock.calls[0][0];
    expect(event.type).toBe('cartUpdated');
    expect(event.detail.count).toBe(3);
  });

  it('handles empty duplicates array (no items removed)', () => {
    cookieValue = 'customerId=user1';
    const state = makeState({
      cart: [makeItem({ id: 'r1' }), makeItem({ id: 'r2' })],
    });
    removeDuplicatesFromCart(state, []);
    expect(state.cart).toHaveLength(2);
  });

  it('uses productId fallback when releaseId and id are missing', () => {
    cookieValue = 'customerId=user1';
    const state = makeState({
      cart: [
        makeItem({ productId: 'p1', name: 'Product 1' }),
        makeItem({ productId: 'p2', name: 'Product 2' }),
      ],
    });
    removeDuplicatesFromCart(state, [
      { item: makeItem({ productId: 'p1' }), reason: 'owned' },
    ]);
    expect(state.cart).toHaveLength(1);
    expect(state.cart[0].name).toBe('Product 2');
  });
});
