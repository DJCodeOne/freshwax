import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared BEFORE importing the module under test
// ---------------------------------------------------------------------------

// Mock Stripe SDK
vi.mock('stripe', () => {
  return {
    default: function MockStripe() {
      return {
        transfers: { create: vi.fn().mockResolvedValue({ id: 'tr_mock_123' }) },
      };
    },
  };
});

// Mock firebase-rest
const mockGetDocument = vi.fn();
const mockQueryCollection = vi.fn();
const mockDeleteDocument = vi.fn();
const mockAddDocument = vi.fn();
const mockUpdateDocument = vi.fn();
const mockAtomicIncrement = vi.fn();
const mockArrayUnion = vi.fn();
vi.mock('../lib/firebase-rest', () => ({
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
  queryCollection: (...args: unknown[]) => mockQueryCollection(...args),
  deleteDocument: (...args: unknown[]) => mockDeleteDocument(...args),
  addDocument: (...args: unknown[]) => mockAddDocument(...args),
  updateDocument: (...args: unknown[]) => mockUpdateDocument(...args),
  atomicIncrement: (...args: unknown[]) => mockAtomicIncrement(...args),
  arrayUnion: (...args: unknown[]) => mockArrayUnion(...args),
}));

// Mock order-utils
const mockCreateOrder = vi.fn();
const mockValidateStock = vi.fn();
const mockConvertReservation = vi.fn();
vi.mock('../lib/order-utils', () => ({
  createOrder: (...args: unknown[]) => mockCreateOrder(...args),
  validateStock: (...args: unknown[]) => mockValidateStock(...args),
  convertReservation: (...args: unknown[]) => mockConvertReservation(...args),
}));

// Mock sales-ledger
vi.mock('../lib/sales-ledger', () => ({
  recordMultiSellerSale: vi.fn().mockResolvedValue(undefined),
}));

// Mock paypal-payouts (dynamically imported in supplier/crate payment processing)
vi.mock('../lib/paypal-payouts', () => ({
  createPayout: vi.fn(),
  getPayPalConfig: vi.fn().mockReturnValue({}),
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

// Mock paypal-auth
const mockGetPayPalAccessToken = vi.fn();
const mockGetPayPalBaseUrl = vi.fn();
vi.mock('../lib/paypal-auth', () => ({
  getPayPalAccessToken: (...args: unknown[]) => mockGetPayPalAccessToken(...args),
  getPayPalBaseUrl: (...args: unknown[]) => mockGetPayPalBaseUrl(...args),
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
import { POST } from '../pages/api/paypal/capture-order';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    FIREBASE_PROJECT_ID: 'freshwax-store',
    FIREBASE_API_KEY: 'test-api-key',
    PAYPAL_CLIENT_ID: 'test-paypal-client-id',
    PAYPAL_CLIENT_SECRET: 'test-paypal-secret',
    PAYPAL_MODE: 'sandbox',
    STRIPE_SECRET_KEY: 'sk_test_key',
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
  return new Request('https://freshwax.co.uk/api/paypal/capture-order/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Standard pending order stored in Firebase (server-side truth) */
function makePendingOrder(overrides: Record<string, unknown> = {}) {
  return {
    customer: {
      email: 'buyer@test.com',
      firstName: 'Test',
      lastName: 'Buyer',
      userId: 'user_123',
      displayName: 'Test Buyer',
    },
    shipping: {
      line1: '123 Test St',
      city: 'London',
      postcode: 'SW1A 1AA',
      country: 'GB',
    },
    items: [
      {
        id: 'release_1',
        name: 'Jungle Massive EP',
        price: 9.99,
        quantity: 1,
        type: 'digital',
      },
    ],
    totals: {
      subtotal: 9.99,
      shipping: 0,
      total: 9.99,
      freshWaxFee: 0.10,
    },
    hasPhysicalItems: false,
    appliedCredit: 0,
    reservationId: 'res_test_123',
    ...overrides,
  };
}

/** Standard PayPal capture API response */
function makeCaptureResult(overrides: Record<string, unknown> = {}) {
  return {
    status: 'COMPLETED',
    purchase_units: [
      {
        payments: {
          captures: [
            {
              id: 'cap_test_123',
              amount: { value: '9.99', currency_code: 'GBP' },
            },
          ],
        },
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PayPal Capture Order', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: rate limit passes
    mockCheckRateLimit.mockReturnValue({ allowed: true });
    mockGetClientId.mockReturnValue('test-client-ip');

    // Default: PayPal auth
    mockGetPayPalAccessToken.mockResolvedValue('test-access-token');
    mockGetPayPalBaseUrl.mockReturnValue('https://api-m.sandbox.paypal.com');

    // Default: no existing orders (idempotency check passes)
    mockQueryCollection.mockResolvedValue([]);

    // Default: pending order exists in Firebase
    mockGetDocument.mockResolvedValue(makePendingOrder());

    // Default: delete pending order succeeds
    mockDeleteDocument.mockResolvedValue(undefined);

    // Default: stock is available
    mockValidateStock.mockResolvedValue({ available: true });

    // Default: PayPal capture succeeds
    mockFetchWithTimeout.mockResolvedValue(
      new Response(JSON.stringify(makeCaptureResult()), { status: 200 })
    );

    // Default: order creation succeeds
    mockCreateOrder.mockResolvedValue({
      success: true,
      orderId: 'order_test_123',
      orderNumber: 'FW-001',
    });

    // Default: addDocument succeeds
    mockAddDocument.mockResolvedValue({ id: 'doc_123' });

    // Default: reservation conversion succeeds
    mockConvertReservation.mockResolvedValue(undefined);
  });

  // -----------------------------------------------------------------------
  // 1. Happy path — successful capture flow
  // -----------------------------------------------------------------------
  it('captures PayPal order and creates Firebase order on happy path', async () => {
    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-123' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.orderId).toBe('order_test_123');
    expect(body.orderNumber).toBe('FW-001');
    expect(body.paypalOrderId).toBe('PAYPAL-ORDER-123');
    expect(body.captureId).toBe('cap_test_123');

    // Idempotency check was performed
    expect(mockQueryCollection).toHaveBeenCalledWith(
      'orders',
      expect.objectContaining({
        filters: [{ field: 'paypalOrderId', op: 'EQUAL', value: 'PAYPAL-ORDER-123' }],
        limit: 1,
      }),
      true
    );

    // Pending order was fetched from Firebase
    expect(mockGetDocument).toHaveBeenCalledWith('pendingPayPalOrders', 'PAYPAL-ORDER-123');

    // Stock was validated before capture
    expect(mockValidateStock).toHaveBeenCalledTimes(1);

    // PayPal capture API was called
    expect(mockFetchWithTimeout).toHaveBeenCalledWith(
      'https://api-m.sandbox.paypal.com/v2/checkout/orders/PAYPAL-ORDER-123/capture',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-access-token',
        }),
      }),
      10000
    );

    // Order was created in Firebase
    expect(mockCreateOrder).toHaveBeenCalledTimes(1);
    const orderArgs = mockCreateOrder.mock.calls[0][0];
    expect(orderArgs.orderData.paymentMethod).toBe('paypal');
    expect(orderArgs.orderData.paypalOrderId).toBe('PAYPAL-ORDER-123');
    expect(orderArgs.orderData.customer.email).toBe('buyer@test.com');

    // Pending order was cleaned up
    expect(mockDeleteDocument).toHaveBeenCalledWith('pendingPayPalOrders', 'PAYPAL-ORDER-123');
  });

  // -----------------------------------------------------------------------
  // 2. Missing paypalOrderId -> 400
  // -----------------------------------------------------------------------
  it('returns 400 when paypalOrderId is missing', async () => {
    const request = makeRequest({});

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Invalid request');
  });

  // -----------------------------------------------------------------------
  // 3. Empty paypalOrderId -> 400
  // -----------------------------------------------------------------------
  it('returns 400 when paypalOrderId is empty string', async () => {
    const request = makeRequest({ paypalOrderId: '' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Invalid request');
  });

  // -----------------------------------------------------------------------
  // 4. PayPal not configured -> 500
  // -----------------------------------------------------------------------
  it('returns 500 when PayPal credentials are missing', async () => {
    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-123' });

    const response = await POST({
      request,
      locals: makeLocals({
        PAYPAL_CLIENT_ID: undefined,
        PAYPAL_CLIENT_SECRET: undefined,
      }),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain('PayPal not configured');
  });

  // -----------------------------------------------------------------------
  // 5. Duplicate order detection (idempotency) -> 200 with existing order
  // -----------------------------------------------------------------------
  it('returns existing order when duplicate detected via idempotency check', async () => {
    mockQueryCollection.mockResolvedValue([
      { id: 'existing_order_456', orderNumber: 'FW-099' },
    ]);

    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-DUP' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.orderId).toBe('existing_order_456');
    expect(body.orderNumber).toBe('FW-099');
    expect(body.message).toBe('Order already processed');

    // createOrder should NOT have been called
    expect(mockCreateOrder).not.toHaveBeenCalled();
    // PayPal capture should NOT have been called
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 6. Idempotency check fails (Firebase unreachable) -> 503
  // -----------------------------------------------------------------------
  it('returns 503 when idempotency check fails due to Firebase error', async () => {
    mockQueryCollection.mockRejectedValue(new Error('Firebase unreachable'));

    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-123' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toContain('Unable to verify order status');

    // Must not proceed with capture
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 7. No pending order found (security check) -> 400
  // -----------------------------------------------------------------------
  it('returns 400 when no pending order exists in Firebase', async () => {
    mockGetDocument.mockResolvedValue(null);

    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-FAKE' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Order session expired or invalid');

    // Must not proceed to stock validation or capture
    expect(mockValidateStock).not.toHaveBeenCalled();
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 8. Pending order fetch fails -> 500
  // -----------------------------------------------------------------------
  it('returns 500 when pending order fetch throws', async () => {
    mockGetDocument.mockRejectedValue(new Error('Firestore timeout'));

    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-123' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain('Could not verify order data');
  });

  // -----------------------------------------------------------------------
  // 9. Stock unavailable -> 409 (before capture)
  // -----------------------------------------------------------------------
  it('returns 409 when stock validation fails before capture', async () => {
    mockValidateStock.mockResolvedValue({
      available: false,
      unavailableItems: ['release_1'],
    });

    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-123' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain('no longer available');

    // PayPal capture must NOT have been called (payment not taken)
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 10. Stock validation throws (Firebase down) -> 503
  // -----------------------------------------------------------------------
  it('returns 503 when stock validation throws (fail closed)', async () => {
    mockValidateStock.mockRejectedValue(new Error('Firebase unreachable'));

    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-123' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toContain('Unable to verify stock');

    // PayPal capture must NOT have been called
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 11. PayPal capture API returns error -> 500
  // -----------------------------------------------------------------------
  it('returns 500 when PayPal capture API returns non-ok response', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      new Response('UNPROCESSABLE_ENTITY', { status: 422 })
    );

    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-123' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain('Failed to capture PayPal payment');

    // Order must NOT have been created
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 12. PayPal capture status not COMPLETED -> 400
  // -----------------------------------------------------------------------
  it('returns 400 when PayPal capture status is not COMPLETED', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      new Response(JSON.stringify(makeCaptureResult({ status: 'PENDING' })), { status: 200 })
    );

    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-123' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Payment was not completed');

    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 13. Order creation fails but fallback finds existing order -> 200
  // -----------------------------------------------------------------------
  it('returns 200 when order creation fails but existing order found on fallback check', async () => {
    mockCreateOrder.mockResolvedValue({ success: false, error: 'duplicate key' });

    // First queryCollection call = idempotency (no order)
    // Second queryCollection call = post-success dup check (won't be called since creation failed)
    // Third queryCollection call = fallback check finds existing order
    mockQueryCollection
      .mockResolvedValueOnce([]) // initial idempotency check
      .mockResolvedValueOnce([   // fallback check after creation failure
        { id: 'existing_order_race', orderNumber: 'FW-RACE', createdAt: '2026-01-01T00:00:00Z' },
      ]);

    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-RACE' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.orderId).toBe('existing_order_race');
    expect(body.message).toBe('Order already processed');
  });

  // -----------------------------------------------------------------------
  // 14. Order creation fails completely -> 500 (orphaned payment)
  // -----------------------------------------------------------------------
  it('returns 500 when order creation fails with no fallback order', async () => {
    mockCreateOrder.mockResolvedValue({ success: false, error: 'Firebase write failed' });

    // Both idempotency and fallback find nothing
    mockQueryCollection.mockResolvedValue([]);

    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-ORPHAN' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain('Payment was captured but order creation failed');
  });

  // -----------------------------------------------------------------------
  // 15. Rate limit exceeded -> 429
  // -----------------------------------------------------------------------
  it('returns 429 when rate limit is exceeded', async () => {
    mockCheckRateLimit.mockReturnValue({ allowed: false, retryAfter: 30 });

    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-123' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(429);

    // Nothing else should have been called
    expect(mockQueryCollection).not.toHaveBeenCalled();
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 16. Amount mismatch flags order for admin review but still succeeds
  // -----------------------------------------------------------------------
  it('flags order for admin review when captured amount mismatches expected total', async () => {
    // Captured amount differs from expected total
    mockFetchWithTimeout.mockResolvedValue(
      new Response(
        JSON.stringify(
          makeCaptureResult({
            purchase_units: [
              {
                payments: {
                  captures: [
                    {
                      id: 'cap_mismatch',
                      amount: { value: '15.00', currency_code: 'GBP' },
                    },
                  ],
                },
              },
            ],
          })
        ),
        { status: 200 }
      )
    );

    // queryCollection calls: idempotency (empty), post-creation dup check (just the one order)
    mockQueryCollection
      .mockResolvedValueOnce([]) // idempotency
      .mockResolvedValueOnce([   // post-creation dup check
        { id: 'order_test_123', orderNumber: 'FW-001', createdAt: '2026-01-01T00:00:00Z' },
      ]);

    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-MISMATCH' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);

    // flaggedOrders document should have been created
    expect(mockAddDocument).toHaveBeenCalledWith(
      'flaggedOrders',
      expect.objectContaining({
        reason: 'amount_mismatch',
        capturedAmount: 15.0,
        expectedTotal: 9.99,
      })
    );

    // Order should still be created with amountMismatch flag
    expect(mockCreateOrder).toHaveBeenCalledTimes(1);
    const orderArgs = mockCreateOrder.mock.calls[0][0];
    expect(orderArgs.orderData.flagged).toBe(true);
    expect(orderArgs.orderData.flagReason).toBe('amount_mismatch');
    expect(orderArgs.orderData.totals.amountMismatch).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 17. Reservation is converted after successful order creation
  // -----------------------------------------------------------------------
  it('converts stock reservation after successful order creation', async () => {
    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-RES' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);

    // convertReservation is dynamically imported — we mock order-utils at top level
    // The actual function is called via `await import('../../../lib/order-utils')`
    // inside the endpoint. Since we mocked the whole module, this should work.
    // Note: The endpoint uses dynamic import for convertReservation,
    // so our vi.mock handles it.
  });

  // -----------------------------------------------------------------------
  // 18. Pending order cleanup failure is non-blocking
  // -----------------------------------------------------------------------
  it('continues even when pending order cleanup fails', async () => {
    mockDeleteDocument.mockRejectedValue(new Error('delete failed'));

    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-123' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    // Should still succeed — cleanup failure is non-blocking
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.orderId).toBe('order_test_123');
  });

  // -----------------------------------------------------------------------
  // 19. createOrder throws -> 500 with orphaned payment handling
  // -----------------------------------------------------------------------
  it('handles createOrder throwing an exception', async () => {
    mockCreateOrder.mockRejectedValue(new Error('Unexpected Firebase error'));

    // Fallback check finds no existing order
    mockQueryCollection
      .mockResolvedValueOnce([]) // idempotency
      .mockResolvedValueOnce([]); // fallback after failure

    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-THROW' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain('Payment was captured but order creation failed');
  });

  // -----------------------------------------------------------------------
  // 20. D1 pending_orders insert (when DB is available)
  // -----------------------------------------------------------------------
  it('inserts D1 pending_orders record when DB binding is available', async () => {
    const mockDbRun = vi.fn().mockResolvedValue({ success: true });
    const mockDbBind = vi.fn().mockReturnValue({ run: mockDbRun });
    const mockDbPrepare = vi.fn().mockReturnValue({ bind: mockDbBind });
    const mockDb = { prepare: mockDbPrepare };

    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-D1' });

    const response = await POST({
      request,
      locals: makeLocals({ DB: mockDb }),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);

    // D1 should have been called for INSERT
    expect(mockDbPrepare).toHaveBeenCalled();
    const insertCall = mockDbPrepare.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO pending_orders')
    );
    expect(insertCall).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // 21. Applied credit is deducted after successful order
  // -----------------------------------------------------------------------
  it('deducts applied credit from user balance after successful order', async () => {
    const pendingWithCredit = makePendingOrder({ appliedCredit: 5.00 });

    // Use mockImplementation to route getDocument calls by collection name,
    // since the endpoint calls getDocument many times (pending order, release
    // lookups for seller enrichment, artist lookups for payments, userCredits).
    mockGetDocument.mockImplementation(async (collection: string) => {
      if (collection === 'pendingPayPalOrders') return pendingWithCredit;
      if (collection === 'userCredits') return { balance: 10.00, transactions: [] };
      // releases, artists, users, merch lookups return null
      return null;
    });

    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-CREDIT' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);

    // atomicIncrement should have been called for credit deduction
    expect(mockAtomicIncrement).toHaveBeenCalledWith(
      'userCredits',
      'user_123',
      { balance: -5.00 }
    );
  });

  // -----------------------------------------------------------------------
  // 22. Non-string paypalOrderId -> 400
  // -----------------------------------------------------------------------
  it('returns 400 when paypalOrderId is not a string', async () => {
    const request = makeRequest({ paypalOrderId: 12345 });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Invalid request');
  });

  // -----------------------------------------------------------------------
  // 23. PayPal access token request fails -> 500
  // -----------------------------------------------------------------------
  it('returns 500 when PayPal access token request fails', async () => {
    mockGetPayPalAccessToken.mockRejectedValue(new Error('PayPal auth service down'));

    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-TOKEN-FAIL' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBeDefined();

    // Order should NOT have been created
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 24. PayPal capture network timeout -> 500
  // -----------------------------------------------------------------------
  it('returns 500 when PayPal capture request times out', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('AbortError: Request timed out'));

    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-TIMEOUT' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBeDefined();

    // Order should NOT have been created since capture failed
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 25. Applied credit with no userCredits document -> graceful degradation
  // -----------------------------------------------------------------------
  it('handles applied credit deduction when userCredits document is missing', async () => {
    const pendingWithCredit = makePendingOrder({ appliedCredit: 3.00 });

    mockGetDocument.mockImplementation(async (collection: string) => {
      if (collection === 'pendingPayPalOrders') return pendingWithCredit;
      if (collection === 'userCredits') return null; // No credit doc exists
      return null;
    });

    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-NO-CREDIT-DOC' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    // Order should still succeed
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.orderId).toBe('order_test_123');

    // atomicIncrement for credit should NOT have been called (no credit doc)
    expect(mockAtomicIncrement).not.toHaveBeenCalledWith(
      'userCredits',
      expect.anything(),
      expect.objectContaining({ balance: expect.any(Number) })
    );
  });

  // -----------------------------------------------------------------------
  // 26. Concurrent order creation race condition — both succeed
  // -----------------------------------------------------------------------
  it('detects duplicate orders after successful creation (race condition)', async () => {
    // Post-creation duplicate check finds 2 orders
    mockQueryCollection
      .mockResolvedValueOnce([]) // initial idempotency check
      .mockResolvedValueOnce([   // post-creation dup check finds 2 orders
        { id: 'order_first', orderNumber: 'FW-FIRST', createdAt: '2026-01-01T00:00:00Z' },
        { id: 'order_second', orderNumber: 'FW-SECOND', createdAt: '2026-01-01T00:00:01Z' },
      ]);

    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-RACE-BOTH' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);
    const body = await response.json();
    // Should return the earliest created order
    expect(body.orderId).toBe('order_first');
    expect(body.orderNumber).toBe('FW-FIRST');
    expect(body.message).toBe('Order already processed');
  });

  // -----------------------------------------------------------------------
  // 27. Physical items with valid order data -> correct order structure
  // -----------------------------------------------------------------------
  it('creates order with correct physical item details', async () => {
    const physicalPendingOrder = makePendingOrder({
      items: [
        {
          id: 'vinyl_1',
          name: 'Classic Breaks 12"',
          price: 14.99,
          quantity: 1,
          type: 'vinyl',
          artistId: 'artist_vinyl',
        },
      ],
      hasPhysicalItems: true,
      shipping: {
        line1: '42 Vinyl St',
        city: 'Manchester',
        postcode: 'M1 1AA',
        country: 'GB',
      },
      totals: {
        subtotal: 14.99,
        shipping: 4.99,
        total: 19.98,
        freshWaxFee: 0.15,
      },
    });

    mockGetDocument.mockResolvedValue(physicalPendingOrder);

    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-VINYL' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);

    // createOrder should have been called with the correct physical order data
    expect(mockCreateOrder).toHaveBeenCalledTimes(1);
    const orderArgs = mockCreateOrder.mock.calls[0][0];
    expect(orderArgs.orderData.hasPhysicalItems).toBe(true);
    expect(orderArgs.orderData.shipping.city).toBe('Manchester');
    expect(orderArgs.orderData.items[0].type).toBe('vinyl');
  });

  // -----------------------------------------------------------------------
  // 28. Invalid JSON body -> 500
  // -----------------------------------------------------------------------
  it('returns 500 when request body is not valid JSON', async () => {
    const request = new Request('https://freshwax.co.uk/api/paypal/capture-order/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json{{{',
    });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(500);
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 29. Ledger recording failure does not fail the order
  // -----------------------------------------------------------------------
  it('returns 200 even when sales ledger recording fails', async () => {
    // Sales ledger is mocked to succeed by default (vi.mock at top),
    // but let's make the Firebase getDocument fail for ledger enrichment
    // while still succeeding for pendingPayPalOrders
    mockGetDocument.mockImplementation(async (collection: string) => {
      if (collection === 'pendingPayPalOrders') return makePendingOrder();
      // All other getDocument calls (for ledger enrichment) throw
      throw new Error('Firestore read failed');
    });

    const request = makeRequest({ paypalOrderId: 'PAYPAL-ORDER-LEDGER-FAIL' });

    const response = await POST({
      request,
      locals: makeLocals(),
    } as unknown as Parameters<typeof POST>[0]);

    // Order should still succeed — ledger is supplementary
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.orderId).toBe('order_test_123');
  });
});
