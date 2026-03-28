import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckoutState } from '../lib/checkout/types';
import type { ClientLogger } from '../lib/client-logger';

// ---------------------------------------------------------------------------
// Mocks for browser globals
// ---------------------------------------------------------------------------

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

let cookieValue = '';
Object.defineProperty(globalThis, 'document', {
  value: {
    get cookie() { return cookieValue; },
    set cookie(v: string) { cookieValue = v; },
  },
  writable: true,
});

// Import the module under test
import {
  calculateTotals,
  removeDuplicatesFromCart,
  getCustomerIdFromCookie,
  loadCart,
} from '../lib/checkout/cart-validation';

// Import history helpers (pure functions, no mocking needed)
import {
  wasPlayedRecently,
  logToHistoryArray,
} from '../lib/playlist-manager/history';
import type { PlaylistHistoryEntry } from '../lib/playlist-manager/types';
import type { GlobalPlaylistItem } from '../lib/types';

// Mock client-logger for history module
vi.mock('../lib/client-logger', () => ({
  createClientLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): ClientLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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

function makeCartItem(overrides: Partial<CartItem> = {}): CartItem {
  return {
    name: 'Test Item',
    price: 9.99,
    quantity: 1,
    ...overrides,
  };
}

function makePlaylistItem(overrides: Partial<GlobalPlaylistItem> = {}): GlobalPlaylistItem {
  return {
    id: 'item-1',
    url: 'https://youtube.com/watch?v=abc',
    platform: 'youtube',
    title: 'Test Track',
    addedAt: new Date().toISOString(),
    addedBy: 'user1',
    addedByName: 'DJ Test',
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
// calculateTotals — edge cases beyond existing tests
// =============================================
describe('calculateTotals (extended)', () => {
  it('handles multiple items of different types', () => {
    const state = makeState({
      cart: [
        makeCartItem({ type: 'digital', price: 0.99, quantity: 10 }),
        makeCartItem({ type: 'vinyl', price: 25, quantity: 1 }),
        makeCartItem({ type: 'merch', price: 15, quantity: 2 }),
      ],
    });
    const totals = calculateTotals(state);
    // subtotal = 9.90 + 25 + 30 = 64.90
    expect(totals.subtotal).toBeCloseTo(64.9, 2);
    expect(totals.hasPhysicalItems).toBe(true);
    // Over 50, so free shipping
    expect(totals.shipping).toBe(0);
    expect(totals.total).toBeCloseTo(64.9, 2);
  });

  it('handles single penny item', () => {
    const state = makeState({
      cart: [makeCartItem({ type: 'digital', price: 0.01, quantity: 1 })],
    });
    const totals = calculateTotals(state);
    expect(totals.subtotal).toBeCloseTo(0.01, 2);
    expect(totals.total).toBeCloseTo(0.01, 2);
    // Fees are still computed even for tiny amounts
    expect(totals.freshWaxFee).toBeCloseTo(0.0001, 4);
    expect(totals.stripeFee).toBeCloseTo(0.20014, 4);
  });

  it('correctly sums with high quantity', () => {
    const state = makeState({
      cart: [makeCartItem({ type: 'digital', price: 1.5, quantity: 100 })],
    });
    const totals = calculateTotals(state);
    expect(totals.subtotal).toBe(150);
    expect(totals.total).toBe(150);
  });

  it('shipping threshold is exactly at 50 (no shipping)', () => {
    const state = makeState({
      cart: [makeCartItem({ type: 'vinyl', price: 25, quantity: 2 })],
    });
    const totals = calculateTotals(state);
    expect(totals.subtotal).toBe(50);
    expect(totals.shipping).toBe(0);
  });

  it('shipping charged at 49.99', () => {
    const state = makeState({
      cart: [makeCartItem({ type: 'vinyl', price: 49.99, quantity: 1 })],
    });
    const totals = calculateTotals(state);
    expect(totals.subtotal).toBeCloseTo(49.99, 2);
    expect(totals.shipping).toBe(4.99);
  });

  it('fees are proportional (1% platform + Stripe formula)', () => {
    const state = makeState({
      cart: [makeCartItem({ type: 'digital', price: 50, quantity: 1 })],
    });
    const totals = calculateTotals(state);
    expect(totals.freshWaxFee).toBe(0.5); // 50 * 0.01
    expect(totals.stripeFee).toBeCloseTo(0.9, 2); // (50 * 0.014) + 0.20 = 0.70 + 0.20
    expect(totals.serviceFees).toBeCloseTo(1.4, 2);
  });
});

// =============================================
// removeDuplicatesFromCart — complex key scenarios
// =============================================
describe('removeDuplicatesFromCart (extended)', () => {
  it('handles duplicate with all three ID fields (releaseId wins)', () => {
    cookieValue = 'customerId=user1';
    const state = makeState({
      cart: [
        makeCartItem({ id: 'id1', productId: 'pid1', releaseId: 'rel1', name: 'Item 1' }),
        makeCartItem({ id: 'id2', productId: 'pid2', releaseId: 'rel2', name: 'Item 2' }),
      ],
    });
    removeDuplicatesFromCart(state, [
      { item: makeCartItem({ id: 'idx', productId: 'pidx', releaseId: 'rel1' }), reason: 'owned' },
    ]);
    expect(state.cart).toHaveLength(1);
    expect(state.cart[0].name).toBe('Item 2');
  });

  it('handles mixed track-level and release-level duplicates', () => {
    cookieValue = 'customerId=user1';
    const state = makeState({
      cart: [
        makeCartItem({ releaseId: 'r1', trackId: 't1', name: 'Track 1' }),
        makeCartItem({ releaseId: 'r1', trackId: 't2', name: 'Track 2' }),
        makeCartItem({ releaseId: 'r2', name: 'Full Album' }),
      ],
    });
    removeDuplicatesFromCart(state, [
      { item: makeCartItem({ releaseId: 'r1', trackId: 't1' }), reason: 'owned' },
      { item: makeCartItem({ releaseId: 'r2' }), reason: 'owned' },
    ]);
    expect(state.cart).toHaveLength(1);
    expect(state.cart[0].name).toBe('Track 2');
  });
});

// =============================================
// wasPlayedRecently (pure function from history module)
// =============================================
describe('wasPlayedRecently', () => {
  it('returns not recent for URL not in map', () => {
    const map = new Map<string, number>();
    const result = wasPlayedRecently(map, 'https://example.com');
    expect(result.recent).toBe(false);
    expect(result.minutesRemaining).toBeUndefined();
  });

  it('returns recent for URL played 30 minutes ago', () => {
    const map = new Map<string, number>();
    map.set('https://example.com', Date.now() - 30 * 60 * 1000);
    const result = wasPlayedRecently(map, 'https://example.com');
    expect(result.recent).toBe(true);
    expect(result.minutesRemaining).toBeGreaterThan(0);
    expect(result.minutesRemaining).toBeLessThanOrEqual(30);
  });

  it('returns not recent for URL played over 1 hour ago', () => {
    const map = new Map<string, number>();
    map.set('https://example.com', Date.now() - 61 * 60 * 1000);
    const result = wasPlayedRecently(map, 'https://example.com');
    expect(result.recent).toBe(false);
    // Should also clean up the entry
    expect(map.has('https://example.com')).toBe(false);
  });

  it('returns not recent for URL played exactly 1 hour ago', () => {
    const map = new Map<string, number>();
    map.set('https://example.com', Date.now() - 60 * 60 * 1000);
    const result = wasPlayedRecently(map, 'https://example.com');
    expect(result.recent).toBe(false);
  });

  it('returns recent for URL played 1 second ago', () => {
    const map = new Map<string, number>();
    map.set('https://example.com', Date.now() - 1000);
    const result = wasPlayedRecently(map, 'https://example.com');
    expect(result.recent).toBe(true);
    expect(result.minutesRemaining).toBe(60);
  });

  it('calculates minutesRemaining correctly (rounds up)', () => {
    const map = new Map<string, number>();
    // 45 minutes ago means 15 minutes remaining
    map.set('https://example.com', Date.now() - 45 * 60 * 1000);
    const result = wasPlayedRecently(map, 'https://example.com');
    expect(result.recent).toBe(true);
    expect(result.minutesRemaining).toBe(15);
  });
});

// =============================================
// logToHistoryArray (pure function from history module)
// =============================================
describe('logToHistoryArray', () => {
  it('adds new item to beginning of empty history', () => {
    const item = makePlaylistItem({ id: 'x1', url: 'https://yt.com/1', title: 'Track 1' });
    const result = logToHistoryArray([], item);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://yt.com/1');
    expect(result[0].title).toBe('Track 1');
    expect(result[0].playedAt).toBeDefined();
  });

  it('adds new item to beginning, preserving existing items', () => {
    const existing: PlaylistHistoryEntry[] = [
      { id: 'old', url: 'https://yt.com/old', platform: 'youtube', title: 'Old Track', playedAt: '2020-01-01' },
    ];
    const item = makePlaylistItem({ id: 'new', url: 'https://yt.com/new', title: 'New Track' });
    const result = logToHistoryArray(existing, item);
    expect(result).toHaveLength(2);
    expect(result[0].url).toBe('https://yt.com/new');
    expect(result[1].url).toBe('https://yt.com/old');
  });

  it('deduplicates by URL and moves to front', () => {
    const existing: PlaylistHistoryEntry[] = [
      { id: 'a', url: 'https://yt.com/1', platform: 'youtube', title: 'First', playedAt: '2020-01-01' },
      { id: 'b', url: 'https://yt.com/2', platform: 'youtube', title: 'Second', playedAt: '2020-01-02' },
    ];
    const item = makePlaylistItem({ id: 'b-new', url: 'https://yt.com/2', title: 'Updated Title' });
    const result = logToHistoryArray(existing, item);
    expect(result).toHaveLength(2);
    // The duplicate should now be first
    expect(result[0].url).toBe('https://yt.com/2');
    expect(result[0].title).toBe('Updated Title');
    expect(result[1].url).toBe('https://yt.com/1');
  });

  it('trims history to MAX_HISTORY_SIZE (100)', () => {
    const existing: PlaylistHistoryEntry[] = Array.from({ length: 100 }, (_, i) => ({
      id: `item-${i}`,
      url: `https://yt.com/${i}`,
      platform: 'youtube',
      title: `Track ${i}`,
      playedAt: '2020-01-01',
    }));
    const item = makePlaylistItem({ id: 'new', url: 'https://yt.com/new' });
    const result = logToHistoryArray(existing, item);
    expect(result).toHaveLength(100);
    expect(result[0].url).toBe('https://yt.com/new');
    // The last old item should be trimmed
    expect(result[99].url).toBe('https://yt.com/98');
  });

  it('does not mutate original history array', () => {
    const existing: PlaylistHistoryEntry[] = [
      { id: 'a', url: 'https://yt.com/1', platform: 'youtube', title: 'A', playedAt: '2020-01-01' },
    ];
    const item = makePlaylistItem({ id: 'b', url: 'https://yt.com/2' });
    const result = logToHistoryArray(existing, item);
    expect(existing).toHaveLength(1);
    expect(result).toHaveLength(2);
    expect(result).not.toBe(existing);
  });

  it('updates thumbnail when existing entry had none', () => {
    const existing: PlaylistHistoryEntry[] = [
      { id: 'a', url: 'https://yt.com/1', platform: 'youtube', title: 'Old Title', playedAt: '2020-01-01' },
    ];
    const item = makePlaylistItem({
      id: 'a',
      url: 'https://yt.com/1',
      title: 'New Title',
      thumbnail: 'https://example.com/thumb.jpg',
    });
    const result = logToHistoryArray(existing, item);
    expect(result[0].thumbnail).toBe('https://example.com/thumb.jpg');
    expect(result[0].title).toBe('New Title');
  });
});

// =============================================
// loadCart — edge cases
// =============================================
describe('loadCart (extended)', () => {
  it('handles object with items as null', () => {
    cookieValue = 'customerId=user1';
    localStorageMock.setItem('freshwax_cart_user1', JSON.stringify({ items: null }));
    const state = makeState();
    const result = loadCart(state);
    // null is falsy, falls through to Array.isArray(null) which is false, so empty array
    expect(result).toEqual([]);
  });

  it('handles object with items as empty object (not array)', () => {
    cookieValue = 'customerId=user1';
    localStorageMock.setItem('freshwax_cart_user1', JSON.stringify({ items: {} }));
    const state = makeState();
    const result = loadCart(state);
    // items is truthy but not an array — still assigned (may be buggy but testing real behavior)
    // The code does: parsed.items ? parsed.items : ...
    // So items = {} (truthy) gets assigned
    expect(result).toEqual({});
  });
});
