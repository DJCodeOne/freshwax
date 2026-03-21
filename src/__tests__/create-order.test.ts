import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared BEFORE importing the module under test
// ---------------------------------------------------------------------------

// Mock firebase-rest
const mockGetDocument = vi.fn();
const mockUpdateDocument = vi.fn();
const mockAddDocument = vi.fn();
const mockClearCache = vi.fn();
const mockAtomicIncrement = vi.fn();
const mockUpdateDocumentConditional = vi.fn();
vi.mock('../lib/firebase-rest', () => ({
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
  updateDocument: (...args: unknown[]) => mockUpdateDocument(...args),
  addDocument: (...args: unknown[]) => mockAddDocument(...args),
  clearCache: (...args: unknown[]) => mockClearCache(...args),
  atomicIncrement: (...args: unknown[]) => mockAtomicIncrement(...args),
  updateDocumentConditional: (...args: unknown[]) => mockUpdateDocumentConditional(...args),
}));

// Mock d1-catalog
vi.mock('../lib/d1-catalog', () => ({
  d1UpsertMerch: vi.fn().mockResolvedValue(undefined),
}));

// Mock rate-limit
const mockCheckRateLimit = vi.fn();
const mockGetClientId = vi.fn();
vi.mock('../lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  getClientId: (...args: unknown[]) => mockGetClientId(...args),
  rateLimitResponse: (retryAfter: number) =>
    new Response(JSON.stringify({ error: 'Rate limited' }), {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
    }),
  RateLimiters: { strict: { maxTokens: 5, refillRate: 1, refillInterval: 60000 } },
}));

// Mock order-utils
vi.mock('../lib/order-utils', () => ({
  generateOrderNumber: () => 'FW-260321-abc123',
}));

// Mock constants
vi.mock('../lib/constants', () => ({
  SITE_URL: 'https://freshwax.co.uk',
}));

// Mock format-utils
vi.mock('../lib/format-utils', () => ({
  formatPrice: (n: number) => `£${n.toFixed(2)}`,
}));

// Mock order email builders
vi.mock('../lib/order/create-order-emails', () => ({
  buildOrderConfirmationEmail: vi.fn().mockReturnValue('<html>Order confirmation</html>'),
  buildStockistFulfillmentEmail: vi.fn().mockReturnValue('<html>Stockist fulfillment</html>'),
  buildDigitalSaleEmail: vi.fn().mockReturnValue('<html>Digital sale</html>'),
  buildMerchSaleEmail: vi.fn().mockReturnValue('<html>Merch sale</html>'),
}));

// Mock api-utils — keep real implementations but mock fetchWithTimeout and logger
const mockFetchWithTimeout = vi.fn();
vi.mock('../lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api-utils')>();
  return {
    ...actual,
    fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args),
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are set up
// ---------------------------------------------------------------------------
import { POST } from '../pages/api/create-order';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    FIREBASE_PROJECT_ID: 'freshwax-store',
    FIREBASE_API_KEY: 'test-api-key',
    RESEND_API_KEY: 'test-resend-key',
    DB: null,
    CACHE: null,
    ...overrides,
  };
}

function makeLocals(envOverrides: Record<string, unknown> = {}) {
  return {
    runtime: { env: makeEnv(envOverrides) },
  } as unknown as App.Locals;
}

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://freshwax.co.uk/api/create-order/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Minimal valid order payload for a digital item */
function makeDigitalOrderPayload(overrides: Record<string, unknown> = {}) {
  return {
    customer: {
      email: 'buyer@test.com',
      firstName: 'Test',
      lastName: 'Buyer',
      userId: 'user_123',
    },
    items: [
      {
        id: 'release_1',
        releaseId: 'release_1',
        name: 'Jungle Massive EP',
        type: 'digital',
        price: 9.99,
        quantity: 1,
        artist: 'Test Artist',
        artistId: 'artist_1',
      },
    ],
    totals: {
      subtotal: 9.99,
      shipping: 0,
      total: 9.99,
    },
    hasPhysicalItems: false,
    ...overrides,
  };
}

/** Minimal valid order payload for a merch item */
function makeMerchOrderPayload(overrides: Record<string, unknown> = {}) {
  return {
    customer: {
      email: 'buyer@test.com',
      firstName: 'Test',
      lastName: 'Buyer',
      userId: 'user_123',
    },
    items: [
      {
        productId: 'merch_1',
        name: 'Underground Lair T-Shirt',
        type: 'merch',
        price: 24.99,
        quantity: 1,
        size: 'L',
        color: 'Black',
      },
    ],
    shipping: {
      address1: '123 Test St',
      city: 'London',
      postcode: 'SW1A 1AA',
      country: 'GB',
    },
    totals: {
      subtotal: 24.99,
      shipping: 4.99,
      total: 29.98,
    },
    hasPhysicalItems: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Create Order', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: rate limit passes
    mockCheckRateLimit.mockReturnValue({ allowed: true });
    mockGetClientId.mockReturnValue('test-client-ip');

    // Default: addDocument succeeds with an ID
    mockAddDocument.mockResolvedValue({ id: 'order_abc123' });

    // Default: getDocument returns a valid release for price validation
    mockGetDocument.mockImplementation(async (collection: string, id: string) => {
      if (collection === 'releases' && id === 'release_1') {
        return {
          price: 9.99,
          digitalPrice: 9.99,
          releaseName: 'Jungle Massive EP',
          artistName: 'Test Artist',
          artistId: 'artist_1',
          tracks: [
            { trackId: 't1', trackName: 'Track One', mp3Url: 'https://r2.test/t1.mp3' },
          ],
          coverArtUrl: 'https://r2.test/cover.webp',
        };
      }
      if (collection === 'users' && id === 'user_123') {
        return { email: 'buyer@test.com', displayName: 'Test Buyer' };
      }
      if (collection === 'artists') {
        return null; // buyer is not an artist
      }
      if (collection === 'merch' && id === 'merch_1') {
        return {
          retailPrice: 24.99,
          variantStock: { 'l_black': { stock: 10, sold: 0 } },
          totalStock: 10,
          _updateTime: '2026-01-01T00:00:00Z',
        };
      }
      return null;
    });

    // Default: updateDocument and updateDocumentConditional succeed
    mockUpdateDocument.mockResolvedValue(undefined);
    mockUpdateDocumentConditional.mockResolvedValue(undefined);

    // Default: atomicIncrement succeeds
    mockAtomicIncrement.mockResolvedValue(undefined);

    // Default: fetchWithTimeout (Resend email API) succeeds
    mockFetchWithTimeout.mockResolvedValue(
      new Response(JSON.stringify({ id: 'email_123' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
  });

  // -----------------------------------------------------------------------
  // 1. Happy path: digital order created successfully
  // -----------------------------------------------------------------------
  it('creates a digital order successfully', async () => {
    const request = makeRequest(makeDigitalOrderPayload());

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.orderId).toBe('order_abc123');
    expect(body.orderNumber).toBe('FW-260321-abc123');

    // Order was saved to Firebase
    expect(mockAddDocument).toHaveBeenCalledWith(
      'orders',
      expect.objectContaining({
        orderNumber: 'FW-260321-abc123',
        paymentStatus: 'pending',
        customer: expect.objectContaining({
          email: 'buyer@test.com',
          firstName: 'Test',
          lastName: 'Buyer',
        }),
      }),
      undefined // idToken
    );

    // Customer order count was incremented
    expect(mockAtomicIncrement).toHaveBeenCalledWith('users', 'user_123', { orderCount: 1 });
  });

  // -----------------------------------------------------------------------
  // 2. Happy path: merch order with shipping
  // -----------------------------------------------------------------------
  it('creates a merch order with shipping', async () => {
    const request = makeRequest(makeMerchOrderPayload());

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.orderId).toBe('order_abc123');

    // Order was saved with physical item details
    expect(mockAddDocument).toHaveBeenCalledWith(
      'orders',
      expect.objectContaining({
        hasPhysicalItems: true,
        shipping: expect.objectContaining({
          address1: '123 Test St',
          city: 'London',
        }),
      }),
      undefined
    );

    // Stock was updated via conditional update
    expect(mockUpdateDocumentConditional).toHaveBeenCalledWith(
      'merch',
      'merch_1',
      expect.objectContaining({
        variantStock: expect.objectContaining({
          'l_black': expect.objectContaining({
            stock: 9,
            sold: 1,
          }),
        }),
      }),
      '2026-01-01T00:00:00Z'
    );

    // Stock movement was recorded
    expect(mockAddDocument).toHaveBeenCalledWith(
      'merch-stock-movements',
      expect.objectContaining({
        productId: 'merch_1',
        type: 'sell',
        quantity: 1,
        previousStock: 10,
        newStock: 9,
      }),
      undefined
    );
  });

  // -----------------------------------------------------------------------
  // 3. Error: missing required customer fields
  // -----------------------------------------------------------------------
  it('returns 400 when customer email is missing', async () => {
    const payload = makeDigitalOrderPayload();
    (payload.customer as Record<string, unknown>).email = '';

    const request = makeRequest(payload);

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Invalid request');

    // No order should have been created
    expect(mockAddDocument).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 4. Error: missing customer firstName
  // -----------------------------------------------------------------------
  it('returns 400 when customer firstName is missing', async () => {
    const payload = makeDigitalOrderPayload();
    (payload.customer as Record<string, unknown>).firstName = '';

    const request = makeRequest(payload);

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Invalid request');
    expect(mockAddDocument).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 5. Error: empty items array
  // -----------------------------------------------------------------------
  it('returns 400 when items array is empty', async () => {
    const payload = makeDigitalOrderPayload({ items: [] });

    const request = makeRequest(payload);

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Invalid request');
    expect(mockAddDocument).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 6. Error: item with negative price
  // -----------------------------------------------------------------------
  it('returns 400 when an item has a non-positive price', async () => {
    const payload = makeDigitalOrderPayload({
      items: [
        {
          id: 'release_1',
          releaseId: 'release_1',
          name: 'Free Release',
          type: 'digital',
          price: -1,
          quantity: 1,
        },
      ],
    });

    const request = makeRequest(payload);

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(400);
    expect(mockAddDocument).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 7. Error: stock validation fails (product not found)
  // -----------------------------------------------------------------------
  it('returns 400 when product is not found during price validation', async () => {
    // Override getDocument so the release lookup returns null
    mockGetDocument.mockImplementation(async (collection: string, id: string) => {
      if (collection === 'releases') return null;
      if (collection === 'users') return { email: 'buyer@test.com' };
      if (collection === 'artists') return null;
      return null;
    });

    const request = makeRequest(makeDigitalOrderPayload());

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Product not found');

    // Order should NOT have been created
    expect(mockAddDocument).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 8. Error: physical items without shipping address
  // -----------------------------------------------------------------------
  it('returns 400 when physical items have no shipping address', async () => {
    const payload = makeMerchOrderPayload({
      shipping: null,
    });

    const request = makeRequest(payload);

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Shipping address required');
    expect(mockAddDocument).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 9. Error: artist account cannot purchase
  // -----------------------------------------------------------------------
  it('returns 403 when an artist-only account attempts to purchase', async () => {
    mockGetDocument.mockImplementation(async (collection: string, id: string) => {
      if (collection === 'releases' && id === 'release_1') {
        return { price: 9.99, digitalPrice: 9.99, releaseName: 'EP', tracks: [] };
      }
      if (collection === 'users' && id === 'user_123') return null; // NOT a customer
      if (collection === 'artists' && id === 'user_123') return { name: 'DJ Test' }; // IS an artist
      return null;
    });

    const request = makeRequest(makeDigitalOrderPayload());

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain('Artist accounts cannot make purchases');
    expect(mockAddDocument).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 10. Security: price manipulation detection
  // -----------------------------------------------------------------------
  it('uses server-side price even when client submits manipulated price', async () => {
    const payload = makeDigitalOrderPayload({
      items: [
        {
          id: 'release_1',
          releaseId: 'release_1',
          name: 'Jungle Massive EP',
          type: 'digital',
          price: 0.01, // Client submits 1p instead of £9.99
          quantity: 1,
        },
      ],
      totals: { subtotal: 0.01, shipping: 0, total: 0.01 },
    });

    const request = makeRequest(payload);

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    // The endpoint should reject because client total (0.01) < server total (9.99) * 0.95
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Price validation failed');
    expect(mockAddDocument).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 11. Rate limit exceeded
  // -----------------------------------------------------------------------
  it('returns 429 when rate limit is exceeded', async () => {
    mockCheckRateLimit.mockReturnValue({ allowed: false, retryAfter: 60 });

    const request = makeRequest(makeDigitalOrderPayload());

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(429);
    expect(mockAddDocument).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 12. Guest checkout (no userId)
  // -----------------------------------------------------------------------
  it('allows guest checkout without userId', async () => {
    const payload = makeDigitalOrderPayload();
    (payload.customer as Record<string, unknown>).userId = undefined;

    const request = makeRequest(payload);

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);

    // Customer order count should NOT be incremented for guests
    expect(mockAtomicIncrement).not.toHaveBeenCalledWith(
      'users',
      expect.anything(),
      { orderCount: 1 }
    );
  });

  // -----------------------------------------------------------------------
  // 13. Firebase write failure returns 500
  // -----------------------------------------------------------------------
  it('returns 500 when Firebase addDocument throws', async () => {
    mockAddDocument.mockRejectedValue(new Error('Firebase unavailable'));

    const request = makeRequest(makeDigitalOrderPayload());

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain('Failed to create order');
  });

  // -----------------------------------------------------------------------
  // 14. Confirmation email sent on success
  // -----------------------------------------------------------------------
  it('sends confirmation email via Resend after order creation', async () => {
    const request = makeRequest(makeDigitalOrderPayload());

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);

    // Resend API was called for the confirmation email
    expect(mockFetchWithTimeout).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-resend-key',
        }),
      }),
      10000
    );
  });

  // -----------------------------------------------------------------------
  // 15. Email failure does not fail the order
  // -----------------------------------------------------------------------
  it('returns 200 even when confirmation email fails', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      new Response('Email service error', { status: 500 })
    );

    const request = makeRequest(makeDigitalOrderPayload());

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    // Order still succeeds even if email fails
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.orderId).toBe('order_abc123');
  });

  // -----------------------------------------------------------------------
  // 16. Invalid JSON body returns 500
  // -----------------------------------------------------------------------
  it('returns 500 when request body is not valid JSON', async () => {
    const request = new Request('https://freshwax.co.uk/api/create-order/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json',
    });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(500);
    expect(mockAddDocument).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 17. Server-side shipping calculation for merch
  // -----------------------------------------------------------------------
  it('calculates merch shipping at £4.99 for orders under £50', async () => {
    const request = makeRequest(makeMerchOrderPayload());

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);

    // Check the order saved to Firebase includes server-calculated shipping
    const orderCall = mockAddDocument.mock.calls.find(
      (call: unknown[]) => call[0] === 'orders'
    );
    expect(orderCall).toBeDefined();
    const savedOrder = orderCall![1] as Record<string, unknown>;
    const totals = savedOrder.totals as Record<string, unknown>;
    expect(totals.merchShipping).toBe(4.99);
  });
});
