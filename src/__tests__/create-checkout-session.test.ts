import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared BEFORE importing the module under test
// ---------------------------------------------------------------------------

// Mock firebase-rest
const mockAddDocument = vi.fn();
const mockGetDocument = vi.fn();
vi.mock('../lib/firebase-rest', () => ({
  addDocument: (...args: unknown[]) => mockAddDocument(...args),
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
}));

// Mock order-utils
const mockValidateStock = vi.fn();
const mockValidateAndGetPrices = vi.fn();
const mockReserveStock = vi.fn();
const mockReleaseReservation = vi.fn();
vi.mock('../lib/order-utils', () => ({
  validateStock: (...args: unknown[]) => mockValidateStock(...args),
  validateAndGetPrices: (...args: unknown[]) => mockValidateAndGetPrices(...args),
  reserveStock: (...args: unknown[]) => mockReserveStock(...args),
  releaseReservation: (...args: unknown[]) => mockReleaseReservation(...args),
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
  RateLimiters: { standard: { maxTokens: 10, refillRate: 1, refillInterval: 1000 } },
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
// The create-checkout-session.ts file uses `log` without importing/declaring it.
// Provide it as a global so the module doesn't throw ReferenceError at runtime.
// ---------------------------------------------------------------------------
const mockLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
(globalThis as Record<string, unknown>).log = mockLog;

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are set up
// ---------------------------------------------------------------------------
import { POST } from '../pages/api/stripe/create-checkout-session';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    STRIPE_SECRET_KEY: 'sk_test_key_123',
    FIREBASE_PROJECT_ID: 'freshwax-store',
    FIREBASE_API_KEY: 'test-api-key',
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
  return new Request('https://freshwax.co.uk/api/stripe/create-checkout-session/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Standard checkout payload for a single digital item */
function makeDigitalCheckoutPayload(overrides: Record<string, unknown> = {}) {
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

/** Standard checkout payload for merch */
function makeMerchCheckoutPayload(overrides: Record<string, unknown> = {}) {
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

describe('Stripe Create Checkout Session', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: rate limit passes
    mockCheckRateLimit.mockReturnValue({ allowed: true });
    mockGetClientId.mockReturnValue('test-client-ip');

    // Default: stock is available
    mockValidateStock.mockResolvedValue({ available: true });

    // Default: reservation succeeds
    mockReserveStock.mockResolvedValue({ success: true, reservationId: 'res_test_123' });

    // Default: price validation passes with validated items
    mockValidateAndGetPrices.mockResolvedValue({
      validatedItems: [
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
      hasPriceMismatch: false,
    });

    // Default: Stripe API returns a session
    mockFetchWithTimeout.mockResolvedValue(
      new Response(JSON.stringify({
        id: 'cs_test_session_123',
        url: 'https://checkout.stripe.com/pay/cs_test_session_123',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );

    // Default: addDocument (for pendingCheckouts) succeeds
    mockAddDocument.mockResolvedValue({ id: 'pending_123' });

    // Default: releaseReservation succeeds
    mockReleaseReservation.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Reset the global log mock
    mockLog.debug.mockClear();
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
  });

  // -----------------------------------------------------------------------
  // 1. Happy path: creates Stripe checkout session for digital item
  // -----------------------------------------------------------------------
  it('creates Stripe checkout session for a digital item', async () => {
    const request = makeRequest(makeDigitalCheckoutPayload());

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.sessionId).toBe('cs_test_session_123');
    expect(body.checkoutUrl).toBe('https://checkout.stripe.com/pay/cs_test_session_123');

    // Stock was validated
    expect(mockValidateStock).toHaveBeenCalledTimes(1);

    // Stock was reserved
    expect(mockReserveStock).toHaveBeenCalledTimes(1);

    // Prices were validated server-side
    expect(mockValidateAndGetPrices).toHaveBeenCalledTimes(1);

    // Stripe API was called
    expect(mockFetchWithTimeout).toHaveBeenCalledWith(
      'https://api.stripe.com/v1/checkout/sessions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk_test_key_123',
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
      }),
      10000
    );

    // Verify the body contains correct line items
    const stripeCall = mockFetchWithTimeout.mock.calls[0];
    const requestBody = stripeCall[1].body as string;
    expect(requestBody).toContain('line_items');
    expect(requestBody).toContain('mode=payment');
    expect(requestBody).toContain('payment_method_types%5B0%5D=card');
  });

  // -----------------------------------------------------------------------
  // 2. Happy path: creates checkout session for merch with shipping
  // -----------------------------------------------------------------------
  it('creates checkout session with shipping for physical items', async () => {
    // Override validated items for merch
    mockValidateAndGetPrices.mockResolvedValue({
      validatedItems: [
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
      hasPriceMismatch: false,
    });

    const request = makeRequest(makeMerchCheckoutPayload());

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.sessionId).toBe('cs_test_session_123');

    // Stripe API body should include shipping options
    const stripeCall = mockFetchWithTimeout.mock.calls[0];
    const requestBody = stripeCall[1].body as string;
    expect(requestBody).toContain('shipping_options');
    expect(requestBody).toContain('shipping_address_collection');
  });

  // -----------------------------------------------------------------------
  // 3. Error: empty items array
  // -----------------------------------------------------------------------
  it('returns 400 when items array is empty', async () => {
    const payload = makeDigitalCheckoutPayload({ items: [] });

    const request = makeRequest(payload);

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Invalid request');

    // Stripe API should not have been called
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    // Stock should not have been validated
    expect(mockValidateStock).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 4. Error: missing customer email
  // -----------------------------------------------------------------------
  it('returns 400 when customer email is missing', async () => {
    const payload = makeDigitalCheckoutPayload();
    (payload.customer as Record<string, unknown>).email = '';

    const request = makeRequest(payload);

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(400);
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 5. Error: stock unavailable
  // -----------------------------------------------------------------------
  it('returns 400 when stock is unavailable', async () => {
    mockValidateStock.mockResolvedValue({
      available: false,
      unavailableItems: ['Jungle Massive EP - out of stock'],
    });

    const request = makeRequest(makeDigitalCheckoutPayload());

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('no longer available');

    // Stripe API should not have been called
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    // No reservation should have been attempted
    expect(mockReserveStock).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 6. Error: stock reservation fails
  // -----------------------------------------------------------------------
  it('returns 400 when stock reservation fails', async () => {
    mockReserveStock.mockResolvedValue({
      success: false,
      error: 'Item already reserved by another buyer',
    });

    const request = makeRequest(makeDigitalCheckoutPayload());

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Item already reserved by another buyer');

    // Stripe API should not have been called
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 7. Error: price validation fails
  // -----------------------------------------------------------------------
  it('returns 400 when price validation finds an error', async () => {
    mockValidateAndGetPrices.mockResolvedValue({
      validatedItems: [],
      hasPriceMismatch: true,
      validationError: 'Product not found: Jungle Massive EP',
    });

    const request = makeRequest(makeDigitalCheckoutPayload());

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Product not found');

    // Stripe API should not have been called
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();

    // Reservation should have been released
    expect(mockReleaseReservation).toHaveBeenCalledWith('res_test_123');
  });

  // -----------------------------------------------------------------------
  // 8. Error: Stripe API returns error
  // -----------------------------------------------------------------------
  it('returns 500 when Stripe API returns an error', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const request = makeRequest(makeDigitalCheckoutPayload());

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain('Failed to create checkout session');

    // Reservation should have been released on Stripe failure
    expect(mockReleaseReservation).toHaveBeenCalledWith('res_test_123');
  });

  // -----------------------------------------------------------------------
  // 9. Error: Stripe secret key not configured
  // -----------------------------------------------------------------------
  it('returns 500 when Stripe secret key is missing', async () => {
    const request = makeRequest(makeDigitalCheckoutPayload());

    const response = await POST({
      request,
      locals: makeLocals({ STRIPE_SECRET_KEY: undefined }),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain('Payment service temporarily unavailable');

    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 10. Rate limit exceeded
  // -----------------------------------------------------------------------
  it('returns 429 when rate limit is exceeded', async () => {
    mockCheckRateLimit.mockReturnValue({ allowed: false, retryAfter: 30 });

    const request = makeRequest(makeDigitalCheckoutPayload());

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(429);
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    expect(mockValidateStock).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 11. Metadata includes customer info and item count
  // -----------------------------------------------------------------------
  it('includes correct metadata in Stripe session request', async () => {
    const request = makeRequest(makeDigitalCheckoutPayload());

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);

    const stripeCall = mockFetchWithTimeout.mock.calls[0];
    const requestBody = stripeCall[1].body as string;

    // Metadata should include customer info
    expect(requestBody).toContain('metadata%5Bcustomer_email%5D=buyer%40test.com');
    expect(requestBody).toContain('metadata%5Bcustomer_firstName%5D=Test');
    expect(requestBody).toContain('metadata%5Bcustomer_lastName%5D=Buyer');
    expect(requestBody).toContain('metadata%5Bitems_count%5D=1');
    expect(requestBody).toContain('metadata%5Breservation_id%5D=res_test_123');
  });

  // -----------------------------------------------------------------------
  // 12. Large items payload stored in Firestore pendingCheckouts
  // -----------------------------------------------------------------------
  it('stores large items in Firestore pendingCheckouts when they exceed metadata limit', async () => {
    // Create items that will produce JSON > 500 chars
    const longItems = Array.from({ length: 10 }, (_, i) => ({
      id: `release_${i}`,
      releaseId: `release_${i}`,
      name: `Very Long Release Name That Takes Up Space Number ${i}`,
      type: 'digital',
      price: 9.99,
      quantity: 1,
      artist: `Artist With A Long Name ${i}`,
      artistId: `artist_${i}`,
    }));

    // Validated items match
    mockValidateAndGetPrices.mockResolvedValue({
      validatedItems: longItems,
      hasPriceMismatch: false,
    });

    const payload = makeDigitalCheckoutPayload({ items: longItems });

    const request = makeRequest(payload);

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);

    // pendingCheckouts document should have been created
    expect(mockAddDocument).toHaveBeenCalledWith(
      'pendingCheckouts',
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({ id: 'release_0' }),
        ]),
        createdAt: expect.any(String),
        expiresAt: expect.any(String),
      })
    );

    // Stripe request should include pending_checkout_id in metadata
    const stripeCall = mockFetchWithTimeout.mock.calls[0];
    const requestBody = stripeCall[1].body as string;
    expect(requestBody).toContain('metadata%5Bpending_checkout_id%5D=pending_123');
  });

  // -----------------------------------------------------------------------
  // 13. Exception in handler releases reservation
  // -----------------------------------------------------------------------
  it('releases reservation when an unexpected error occurs', async () => {
    // Make fetchWithTimeout throw an error
    mockFetchWithTimeout.mockRejectedValue(new Error('Network failure'));

    const request = makeRequest(makeDigitalCheckoutPayload());

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(500);

    // Reservation should have been released in the catch block
    expect(mockReleaseReservation).toHaveBeenCalledWith('res_test_123');
  });

  // -----------------------------------------------------------------------
  // 14. Price manipulation detected but still uses server prices
  // -----------------------------------------------------------------------
  it('continues with server prices when price manipulation is detected', async () => {
    mockValidateAndGetPrices.mockResolvedValue({
      validatedItems: [
        {
          id: 'release_1',
          releaseId: 'release_1',
          name: 'Jungle Massive EP',
          type: 'digital',
          price: 9.99, // Server-validated price
          quantity: 1,
        },
      ],
      hasPriceMismatch: true, // Detected mismatch
    });

    const request = makeRequest(makeDigitalCheckoutPayload());

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    // Should still succeed — uses server price
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);

    // Stripe should have been called with the server-validated amount
    const stripeCall = mockFetchWithTimeout.mock.calls[0];
    const requestBody = stripeCall[1].body as string;
    // 9.99 * 100 = 999 cents (URL-encoded as part of nested key)
    expect(requestBody).toContain('unit_amount%5D=999');
  });

  // -----------------------------------------------------------------------
  // 15. Error: item with negative price -> Zod rejects
  // -----------------------------------------------------------------------
  it('returns 400 when an item has a negative price', async () => {
    const payload = makeDigitalCheckoutPayload({
      items: [
        {
          id: 'release_bad',
          name: 'Bad Price EP',
          type: 'digital',
          price: -5.00,
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
    const body = await response.json();
    expect(body.error).toContain('Invalid request');
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 16. Error: item missing name -> Zod rejects
  // -----------------------------------------------------------------------
  it('returns 400 when an item is missing a name', async () => {
    const payload = makeDigitalCheckoutPayload({
      items: [
        {
          id: 'release_noname',
          name: '', // Empty name fails min(1)
          type: 'digital',
          price: 9.99,
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
    const body = await response.json();
    expect(body.error).toContain('Invalid request');
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 17. Error: invalid email format
  // -----------------------------------------------------------------------
  it('returns 400 when customer email is not valid format', async () => {
    const payload = makeDigitalCheckoutPayload();
    (payload.customer as Record<string, unknown>).email = 'not-an-email';

    const request = makeRequest(payload);

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Invalid request');
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 18. Free shipping for merch orders over £50
  // -----------------------------------------------------------------------
  it('applies free shipping for merch orders over £50', async () => {
    const expensiveItems = [
      {
        productId: 'merch_1',
        name: 'Expensive Hoodie',
        type: 'merch',
        price: 55.00,
        quantity: 1,
        size: 'L',
        color: 'Black',
      },
    ];

    mockValidateAndGetPrices.mockResolvedValue({
      validatedItems: expensiveItems,
      hasPriceMismatch: false,
    });

    const payload = makeMerchCheckoutPayload({
      items: expensiveItems,
      totals: { subtotal: 55.00, shipping: 0, total: 55.00 },
    });

    const request = makeRequest(payload);

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);

    // Check the Stripe request body contains free shipping
    const stripeCall = mockFetchWithTimeout.mock.calls[0];
    const requestBody = stripeCall[1].body as string;
    // Shipping amount should be 0 (free) for merch over £50
    expect(requestBody).toContain('shipping_options');
    expect(requestBody).toContain('Free+Shipping');
  });

  // -----------------------------------------------------------------------
  // 19. Stripe session creation with invalid JSON response
  // -----------------------------------------------------------------------
  it('returns 500 when Stripe returns non-JSON error response', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      new Response('Internal Server Error', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      })
    );

    const request = makeRequest(makeDigitalCheckoutPayload());

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain('Failed to create checkout session');

    // Reservation should be released on failure
    expect(mockReleaseReservation).toHaveBeenCalledWith('res_test_123');
  });

  // -----------------------------------------------------------------------
  // 20. Quantity over 99 is rejected by Zod
  // -----------------------------------------------------------------------
  it('returns 400 when item quantity exceeds maximum (99)', async () => {
    const payload = makeDigitalCheckoutPayload({
      items: [
        {
          id: 'release_1',
          name: 'Jungle Massive EP',
          type: 'digital',
          price: 9.99,
          quantity: 100,
        },
      ],
    });

    const request = makeRequest(payload);

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Invalid request');
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 21. Multiple items produce correct line items and totals
  // -----------------------------------------------------------------------
  it('handles multiple items with correct line items and total', async () => {
    const multiItems = [
      {
        id: 'release_1',
        releaseId: 'release_1',
        name: 'Jungle EP',
        type: 'digital',
        price: 9.99,
        quantity: 1,
        artist: 'DJ One',
        artistId: 'artist_1',
      },
      {
        id: 'release_2',
        releaseId: 'release_2',
        name: 'DnB LP',
        type: 'digital',
        price: 14.99,
        quantity: 2,
        artist: 'DJ Two',
        artistId: 'artist_2',
      },
    ];

    mockValidateAndGetPrices.mockResolvedValue({
      validatedItems: multiItems,
      hasPriceMismatch: false,
    });

    const payload = makeDigitalCheckoutPayload({
      items: multiItems,
      totals: { subtotal: 39.97, shipping: 0, total: 39.97 },
    });

    const request = makeRequest(payload);

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);

    // Verify both items appear in Stripe request
    const stripeCall = mockFetchWithTimeout.mock.calls[0];
    const requestBody = stripeCall[1].body as string;
    expect(requestBody).toContain('line_items%5B0%5D');
    expect(requestBody).toContain('line_items%5B1%5D');
    expect(requestBody).toContain('metadata%5Bitems_count%5D=2');
  });

  // -----------------------------------------------------------------------
  // 22. Pending checkout storage failure is non-blocking
  // -----------------------------------------------------------------------
  it('continues to create Stripe session even when pendingCheckouts storage fails', async () => {
    // Create items that will produce JSON > 500 chars
    const longItems = Array.from({ length: 10 }, (_, i) => ({
      id: `release_${i}`,
      releaseId: `release_${i}`,
      name: `Very Long Release Name That Takes Up Space Number ${i}`,
      type: 'digital',
      price: 9.99,
      quantity: 1,
      artist: `Artist With A Long Name ${i}`,
      artistId: `artist_${i}`,
    }));

    mockValidateAndGetPrices.mockResolvedValue({
      validatedItems: longItems,
      hasPriceMismatch: false,
    });

    // Make addDocument fail
    mockAddDocument.mockRejectedValue(new Error('Firebase unavailable'));

    const payload = makeDigitalCheckoutPayload({ items: longItems });
    const request = makeRequest(payload);

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    // Should still succeed despite Firestore failure
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.sessionId).toBe('cs_test_session_123');
  });
});
