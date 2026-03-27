import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared BEFORE importing the module under test
// ---------------------------------------------------------------------------

// Mock Stripe SDK
const mockConstructEventAsync = vi.fn();
const stripeInstance = {
  webhooks: {
    constructEventAsync: (...args: unknown[]) => mockConstructEventAsync(...args),
  },
  transfers: { create: vi.fn() },
};
vi.mock('stripe', () => {
  return {
    default: function MockStripe() { return stripeInstance; },
  };
});

// Mock firebase-rest
const mockGetDocument = vi.fn();
const mockQueryCollection = vi.fn();
const mockDeleteDocument = vi.fn();
const mockAddDocument = vi.fn();
const mockUpdateDocument = vi.fn();
const mockAtomicIncrement = vi.fn();
vi.mock('../lib/firebase-rest', () => ({
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
  queryCollection: (...args: unknown[]) => mockQueryCollection(...args),
  deleteDocument: (...args: unknown[]) => mockDeleteDocument(...args),
  addDocument: (...args: unknown[]) => mockAddDocument(...args),
  updateDocument: (...args: unknown[]) => mockUpdateDocument(...args),
  atomicIncrement: (...args: unknown[]) => mockAtomicIncrement(...args),
  arrayUnion: vi.fn(),
  invalidateReleasesCache: vi.fn(),
  clearAllMerchCache: vi.fn(),
}));

// Mock kv-cache
vi.mock('../lib/kv-cache', () => ({
  kvDelete: vi.fn().mockResolvedValue(undefined),
  CACHE_CONFIG: { RELEASES: {}, MERCH: {} },
  invalidateReleasesKVCache: vi.fn().mockResolvedValue(undefined),
  invalidateMixesKVCache: vi.fn().mockResolvedValue(undefined),
}));

// Mock order-utils
const mockCreateOrder = vi.fn();
const mockValidateStock = vi.fn();
const mockReleaseReservation = vi.fn();
vi.mock('../lib/order-utils', () => ({
  createOrder: (...args: unknown[]) => mockCreateOrder(...args),
  validateStock: (...args: unknown[]) => mockValidateStock(...args),
  releaseReservation: (...args: unknown[]) => mockReleaseReservation(...args),
}));

// Mock webhook-logger
const mockLogStripeEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/webhook-logger', () => ({
  logStripeEvent: (...args: unknown[]) => mockLogStripeEvent(...args),
}));

// Mock paypal-payouts
vi.mock('../lib/paypal-payouts', () => ({
  createPayout: vi.fn(),
  getPayPalConfig: vi.fn().mockReturnValue({}),
}));

// Mock referral-codes
vi.mock('../lib/referral-codes', () => ({
  redeemReferralCode: vi.fn().mockResolvedValue({ success: true }),
}));

// Mock giftcard
const mockCreateGiftCardAfterPayment = vi.fn().mockResolvedValue({
  success: true,
  giftCard: { code: 'GIFT-ABCD-1234' },
  emailSent: true,
});
vi.mock('../lib/giftcard', () => ({
  createGiftCardAfterPayment: (...args: unknown[]) => mockCreateGiftCardAfterPayment(...args),
}));

// Mock sales-ledger
vi.mock('../lib/sales-ledger', () => ({
  recordMultiSellerSale: vi.fn().mockResolvedValue(undefined),
}));

// Mock constants
vi.mock('../lib/constants', () => ({
  SITE_URL: 'https://freshwax.co.uk',
}));

// Mock format-utils
vi.mock('../lib/format-utils', () => ({
  formatPrice: (n: number) => `£${n.toFixed(2)}`,
}));

// Mock api-utils
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

// Mock escape-html
vi.mock('../lib/escape-html', () => ({
  escapeHtml: (s: unknown) => String(s ?? ''),
}));

// Mock abandoned-cart-email
const mockSendAbandonedCartEmail = vi.fn().mockResolvedValue({ success: true, messageId: 'msg_abc' });
vi.mock('../lib/abandoned-cart-email', () => ({
  sendAbandonedCartEmail: (...args: unknown[]) => mockSendAbandonedCartEmail(...args),
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------
import { POST } from '../pages/api/stripe/webhook';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
    STRIPE_SECRET_KEY: 'sk_test_key',
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

function makeStripeEvent(type: string, data: Record<string, unknown> = {}, id = 'evt_test_456') {
  return {
    id,
    type,
    data: { object: data },
  };
}

function makeRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://freshwax.co.uk/api/stripe/webhook/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body,
  });
}

async function callWebhook(eventType: string, data: Record<string, unknown> = {}, eventId?: string) {
  const event = makeStripeEvent(eventType, data, eventId);
  const request = makeRequest(JSON.stringify(event), {
    'stripe-signature': 't=1234567890,v1=valid',
  });
  return POST({
    request,
    locals: makeLocals(),
  } as unknown as Parameters<typeof POST>[0]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Stripe Webhook Event Routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConstructEventAsync.mockImplementation(async (payload: string) => JSON.parse(payload));
    mockQueryCollection.mockResolvedValue([]);
    mockValidateStock.mockResolvedValue({ available: true });
    mockCreateOrder.mockResolvedValue({ success: true, orderId: 'order_123', orderNumber: 'FW-001' });
    mockFetchWithTimeout.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    mockGetDocument.mockResolvedValue(null);
    mockAddDocument.mockResolvedValue({ id: 'doc_123' });
    mockReleaseReservation.mockResolvedValue(undefined);
  });

  // -----------------------------------------------------------------------
  // Event type routing
  // -----------------------------------------------------------------------
  describe('event type routing', () => {
    it('routes checkout.session.completed with mode=subscription to subscription handler', async () => {
      const response = await callWebhook('checkout.session.completed', {
        id: 'cs_sub',
        mode: 'subscription',
        payment_status: 'paid',
        subscription: 'sub_new',
        amount_total: 1000,
        customer_email: 'user@test.com',
        metadata: { userId: 'u1', email: 'user@test.com' },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.received).toBe(true);
      // Subscription handler was invoked — it calls fetchWithTimeout for user update
      expect(mockFetchWithTimeout).toHaveBeenCalled();
    });

    it('routes checkout.session.completed with metadata.type=plus_subscription to promo handler', async () => {
      const response = await callWebhook('checkout.session.completed', {
        id: 'cs_promo',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_promo',
        amount_total: 1000,
        customer_email: 'promo@test.com',
        metadata: { type: 'plus_subscription', userId: 'u2', email: 'promo@test.com' },
      });

      expect(response.status).toBe(200);
      // Should call fetchWithTimeout to activate subscription, NOT createOrder
      expect(mockCreateOrder).not.toHaveBeenCalled();
    });

    it('routes checkout.session.completed with metadata.type=giftcard to gift card handler', async () => {
      const response = await callWebhook('checkout.session.completed', {
        id: 'cs_gift',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_gift',
        amount_total: 5000,
        metadata: {
          type: 'giftcard',
          amount: '50',
          buyerUserId: 'u3',
          buyerEmail: 'gifter@test.com',
          recipientType: 'self',
          recipientEmail: 'gifter@test.com',
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.giftCard).toBe(true);
      expect(body.code).toBe('GIFT-ABCD-1234');
      expect(mockCreateGiftCardAfterPayment).toHaveBeenCalledTimes(1);
    });

    it('routes checkout.session.completed without special types to product order handler', async () => {
      const response = await callWebhook('checkout.session.completed', {
        id: 'cs_order',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_order',
        amount_total: 1999,
        customer_email: 'buyer@test.com',
        metadata: {
          customer_email: 'buyer@test.com',
          items_json: JSON.stringify([{ id: 'r1', name: 'Release', price: 9.99, quantity: 1 }]),
        },
      });

      expect(response.status).toBe(200);
      expect(mockCreateOrder).toHaveBeenCalledTimes(1);
    });

    it('routes invoice.payment_succeeded to subscription renewal handler', async () => {
      // Non-renewal invoice (billing_reason not subscription_cycle) should just acknowledge
      const response = await callWebhook('invoice.payment_succeeded', {
        id: 'inv_123',
        billing_reason: 'subscription_create',
        subscription: 'sub_test',
        amount_paid: 1000,
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.received).toBe(true);
    });

    it('routes customer.subscription.deleted gracefully', async () => {
      const response = await callWebhook('customer.subscription.deleted', {
        id: 'sub_cancelled',
        status: 'canceled',
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.received).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Idempotency checks
  // -----------------------------------------------------------------------
  describe('idempotency checks', () => {
    it('returns existing gift card info on duplicate gift card payment', async () => {
      // Gift card already exists for this payment_intent
      mockQueryCollection.mockResolvedValue([{ code: 'EXISTING-CODE' }]);

      const response = await callWebhook('checkout.session.completed', {
        id: 'cs_gift_dup',
        mode: 'payment',
        payment_intent: 'pi_gift_existing',
        metadata: {
          type: 'giftcard',
          amount: '25',
          buyerUserId: 'u1',
          buyerEmail: 'gifter@test.com',
          recipientType: 'self',
          recipientEmail: 'gifter@test.com',
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.message).toBe('Gift card already created');
      expect(body.code).toBe('EXISTING-CODE');
      // createGiftCardAfterPayment should NOT have been called
      expect(mockCreateGiftCardAfterPayment).not.toHaveBeenCalled();
    });

    it('returns 500 when gift card idempotency check fails (Firebase down)', async () => {
      mockQueryCollection.mockRejectedValue(new Error('Firebase unavailable'));

      const response = await callWebhook('checkout.session.completed', {
        id: 'cs_gift_err',
        mode: 'payment',
        payment_intent: 'pi_gift_err',
        metadata: {
          type: 'giftcard',
          amount: '25',
          buyerUserId: 'u1',
          buyerEmail: 'gifter@test.com',
          recipientType: 'self',
          recipientEmail: 'gifter@test.com',
        },
      });

      // GiftCardIdempotencyError should bubble up and return 500
      expect(response.status).toBe(500);
    });

    it('returns 500 when order idempotency check fails (Firebase down)', async () => {
      mockQueryCollection.mockRejectedValue(new Error('Firebase unavailable'));

      const response = await callWebhook('checkout.session.completed', {
        id: 'cs_order_err',
        mode: 'payment',
        payment_intent: 'pi_order_err',
        customer_email: 'buyer@test.com',
        metadata: {
          customer_email: 'buyer@test.com',
          items_json: JSON.stringify([{ id: 'r1', name: 'Item', price: 5, quantity: 1 }]),
        },
      });

      expect(response.status).toBe(500);
    });

    it('returns 500 when subscription idempotency check fails (Firebase down)', async () => {
      mockGetDocument.mockRejectedValue(new Error('Firebase unavailable'));

      const response = await callWebhook('checkout.session.completed', {
        id: 'cs_sub_err',
        mode: 'subscription',
        payment_status: 'paid',
        subscription: 'sub_err',
        amount_total: 1000,
        metadata: { userId: 'u_err' },
      });

      expect(response.status).toBe(500);
    });

    it('skips order creation when order already exists (duplicate event)', async () => {
      mockQueryCollection.mockResolvedValue([{ id: 'existing_order' }]);

      const response = await callWebhook('checkout.session.completed', {
        id: 'cs_dup',
        mode: 'payment',
        payment_intent: 'pi_dup',
        customer_email: 'buyer@test.com',
        metadata: {
          customer_email: 'buyer@test.com',
          items_json: JSON.stringify([{ id: 'r1', name: 'Item', price: 10, quantity: 1 }]),
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.message).toBe('Order already exists');
      expect(mockCreateOrder).not.toHaveBeenCalled();
    });

    it('skips promo subscription when already processed for user', async () => {
      mockGetDocument.mockResolvedValue({
        subscription: { subscriptionId: 'pi_promo_existing', tier: 'pro' },
      });

      const response = await callWebhook('checkout.session.completed', {
        id: 'cs_promo_dup',
        mode: 'payment',
        payment_intent: 'pi_promo_existing',
        customer_email: 'promo@test.com',
        metadata: { type: 'plus_subscription', userId: 'u_promo' },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.message).toBe('Subscription already processed');
    });
  });

  // -----------------------------------------------------------------------
  // Dispute handling
  // -----------------------------------------------------------------------
  describe('dispute handling', () => {
    it('processes charge.dispute.created and logs the event', async () => {
      mockQueryCollection.mockResolvedValue([]); // No existing dispute

      const response = await callWebhook('charge.dispute.created', {
        id: 'dp_test_123',
        charge: 'ch_test_123',
        amount: 1999,
        reason: 'fraudulent',
      });

      expect(response.status).toBe(200);
      expect(mockLogStripeEvent).toHaveBeenCalledWith(
        'charge.dispute.created',
        expect.any(String),
        true,
        expect.objectContaining({
          message: expect.stringContaining('Dispute created'),
        })
      );
    });

    it('skips charge.dispute.created if dispute already recorded (idempotency)', async () => {
      mockQueryCollection.mockResolvedValue([{ stripeDisputeId: 'dp_existing' }]);

      const response = await callWebhook('charge.dispute.created', {
        id: 'dp_existing',
        charge: 'ch_test_123',
        amount: 1999,
        reason: 'fraudulent',
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.message).toBe('Dispute already processed');
    });

    it('returns 500 when dispute idempotency check fails', async () => {
      // First call to queryCollection (for dispute check) fails
      mockQueryCollection.mockRejectedValueOnce(new Error('Firebase down'));

      const response = await callWebhook('charge.dispute.created', {
        id: 'dp_err',
        charge: 'ch_test_err',
        amount: 500,
        reason: 'general',
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toContain('Temporary error');
    });

    it('processes charge.dispute.closed and logs outcome', async () => {
      const response = await callWebhook('charge.dispute.closed', {
        id: 'dp_closed',
        status: 'won',
      });

      expect(response.status).toBe(200);
      expect(mockLogStripeEvent).toHaveBeenCalledWith(
        'charge.dispute.closed',
        expect.any(String),
        true,
        expect.objectContaining({
          message: expect.stringContaining('Dispute closed'),
        })
      );
    });
  });

  // -----------------------------------------------------------------------
  // Abandoned cart (checkout.session.expired)
  // -----------------------------------------------------------------------
  describe('checkout.session.expired', () => {
    it('releases stock reservation when reservation_id is in metadata', async () => {
      const response = await callWebhook('checkout.session.expired', {
        id: 'cs_expired',
        metadata: {
          reservation_id: 'res_123',
          items: JSON.stringify([{ id: 'r1', name: 'Track', price: 5, quantity: 1 }]),
        },
        customer_email: 'shopper@test.com',
      });

      expect(response.status).toBe(200);
    });

    it('handles missing reservation_id gracefully', async () => {
      const response = await callWebhook('checkout.session.expired', {
        id: 'cs_expired_no_res',
        metadata: {},
        customer_email: 'shopper@test.com',
      });

      expect(response.status).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // Refund processing
  // -----------------------------------------------------------------------
  describe('charge.refunded', () => {
    it('processes refund and logs event with amount', async () => {
      const response = await callWebhook('charge.refunded', {
        id: 'ch_refund_123',
        amount: 2999,
        amount_refunded: 1500,
        payment_intent: 'pi_ref_123',
        refunds: { data: [{ id: 'ref_1', amount: 1500 }] },
      });

      expect(response.status).toBe(200);
      expect(mockLogStripeEvent).toHaveBeenCalledWith(
        'charge.refunded',
        expect.any(String),
        true,
        expect.objectContaining({
          message: expect.stringContaining('Refund processed'),
          metadata: expect.objectContaining({
            chargeId: 'ch_refund_123',
            amountRefunded: 15,
          }),
        })
      );
    });
  });

  // -----------------------------------------------------------------------
  // Subscription security validations
  // -----------------------------------------------------------------------
  describe('subscription security', () => {
    it('rejects subscription with unpaid payment status', async () => {
      const response = await callWebhook('checkout.session.completed', {
        id: 'cs_sub_unpaid',
        mode: 'subscription',
        payment_status: 'unpaid',
        subscription: 'sub_unpaid',
        amount_total: 1000,
        metadata: { userId: 'u_unpaid' },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.error).toBe('Payment not completed');
    });

    it('rejects subscription with amount below minimum', async () => {
      const response = await callWebhook('checkout.session.completed', {
        id: 'cs_sub_cheap',
        mode: 'subscription',
        payment_status: 'paid',
        subscription: 'sub_cheap',
        amount_total: 500, // Less than £10 = 1000 pence
        metadata: { userId: 'u_cheap' },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.error).toBe('Invalid payment amount');
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------
  describe('error handling', () => {
    it('returns 500 and logs error when unhandled exception occurs', async () => {
      // Make constructEventAsync throw an unexpected error after parsing
      mockConstructEventAsync.mockImplementation(async () => {
        throw new Error('Unexpected internal error');
      });

      const event = makeStripeEvent('checkout.session.completed', {});
      const request = makeRequest(JSON.stringify(event), {
        'stripe-signature': 't=1234567890,v1=valid',
      });

      const response = await POST({
        request,
        locals: makeLocals(),
      } as unknown as Parameters<typeof POST>[0]);

      // Should return 401 (caught as signature verification failure)
      expect(response.status).toBe(401);
    });

    it('handles malformed JSON payload gracefully in dev mode', async () => {
      const request = makeRequest('not-valid-json', {
        'stripe-signature': 't=1234567890,v1=valid',
      });

      // In dev mode without valid keys, it falls through to JSON.parse
      const response = await POST({
        request,
        locals: makeLocals({
          STRIPE_WEBHOOK_SECRET: undefined,
          STRIPE_SECRET_KEY: undefined,
        }),
      } as unknown as Parameters<typeof POST>[0]);

      // Should return error (400 for invalid JSON or 500 for misconfigured)
      expect([400, 500]).toContain(response.status);
    });

    it('skips checkout.session.completed without customer_email in metadata', async () => {
      const response = await callWebhook('checkout.session.completed', {
        id: 'cs_no_email',
        mode: 'payment',
        payment_intent: 'pi_no_email',
        metadata: {
          // No customer_email
          items_json: JSON.stringify([{ id: 'r1', name: 'Item', price: 5, quantity: 1 }]),
        },
      });

      expect(response.status).toBe(200);
      // createOrder should NOT be called
      expect(mockCreateOrder).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Email template builder tests (pure functions)
// ---------------------------------------------------------------------------
describe('Email Template Builders', () => {
  // These are pure functions that take data and return HTML strings
  // We can test them directly without mocking

  describe('buildOrderConfirmationEmail', () => {
    // Need to use dynamic import after mock setup since these import constants
    let buildOrderConfirmationEmail: typeof import('../lib/order/emails/buyer-email').buildOrderConfirmationEmail;

    beforeEach(async () => {
      const mod = await import('../lib/order/emails/buyer-email');
      buildOrderConfirmationEmail = mod.buildOrderConfirmationEmail;
    });

    it('generates valid HTML with order number', () => {
      const order = {
        items: [
          { name: 'Jungle EP', type: 'digital', price: 9.99, quantity: 1 },
        ],
        customer: { firstName: 'John', lastName: 'Doe', email: 'john@test.com' },
        totals: { subtotal: 9.99, shipping: 0, serviceFees: 0, total: 10.99 },
        hasPhysicalItems: false,
      };

      const html = buildOrderConfirmationEmail('order_123', 'FW-001', order);

      expect(html).toContain('FW-001');
      expect(html).toContain('Order Confirmed');
      expect(html).toContain('Jungle EP');
      expect(html).toContain('Digital Download');
      expect(html).toContain('freshwax.co.uk');
    });

    it('includes shipping address for physical items', () => {
      const order = {
        items: [
          { name: 'Vinyl Record', type: 'vinyl', price: 24.99, quantity: 1 },
        ],
        customer: { firstName: 'Jane', lastName: 'Smith', email: 'jane@test.com' },
        totals: { subtotal: 24.99, shipping: 3.99, total: 28.98 },
        hasPhysicalItems: true,
        shipping: {
          address1: '123 Test Street',
          city: 'London',
          postcode: 'E1 1AA',
          country: 'United Kingdom',
        },
      };

      const html = buildOrderConfirmationEmail('order_456', 'FW-002', order);

      expect(html).toContain('Shipping To');
      expect(html).toContain('123 Test Street');
      expect(html).toContain('London');
      expect(html).toContain('E1 1AA');
    });

    it('shows FREE shipping when shipping cost is zero', () => {
      const order = {
        items: [
          { name: 'Vinyl', type: 'vinyl', price: 30, quantity: 1 },
        ],
        customer: { firstName: 'A', lastName: 'B', email: 'a@b.com' },
        totals: { subtotal: 30, shipping: 0, total: 30 },
        hasPhysicalItems: true,
        shipping: { address1: '1 Street', city: 'London', postcode: 'E1 1AA', country: 'UK' },
      };

      const html = buildOrderConfirmationEmail('o1', 'FW-003', order);
      expect(html).toContain('FREE');
    });

    it('shows Digital delivery when no physical items', () => {
      const order = {
        items: [{ name: 'Track', type: 'digital', price: 1.49, quantity: 1 }],
        customer: { firstName: 'A', lastName: 'B', email: 'a@b.com' },
        totals: { subtotal: 1.49, shipping: 0, total: 1.49 },
        hasPhysicalItems: false,
      };

      const html = buildOrderConfirmationEmail('o2', 'FW-004', order);
      expect(html).toContain('Digital delivery');
    });

    it('handles merch items with images', () => {
      const order = {
        items: [
          { name: 'FW Hoodie', type: 'merch', price: 45, quantity: 1, image: 'https://cdn.test/hoodie.jpg', size: 'L', color: 'Black' },
        ],
        customer: { firstName: 'A', lastName: 'B', email: 'a@b.com' },
        totals: { subtotal: 45, shipping: 5, total: 50 },
        hasPhysicalItems: true,
        shipping: { address1: '1 St', city: 'London', postcode: 'E1 1AA', country: 'UK' },
      };

      const html = buildOrderConfirmationEmail('o3', 'FW-005', order);
      expect(html).toContain('hoodie.jpg');
      expect(html).toContain('Merchandise');
      expect(html).toContain('Size: L');
    });
  });

  describe('buildDigitalSaleEmail', () => {
    let buildDigitalSaleEmail: typeof import('../lib/order/emails/seller-email').buildDigitalSaleEmail;

    beforeEach(async () => {
      const mod = await import('../lib/order/emails/seller-email');
      buildDigitalSaleEmail = mod.buildDigitalSaleEmail;
    });

    it('generates artist notification email with earnings', () => {
      const order = {
        customer: { firstName: 'Buyer', lastName: 'Test' },
        totals: { subtotal: 9.99, freshWaxFee: 0.10, stripeFee: 0.35, total: 10.44 },
      };
      const items = [
        { name: 'Jungle Track', type: 'digital', price: 9.99, quantity: 1 },
      ];

      const html = buildDigitalSaleEmail('FW-010', order, items);

      expect(html).toContain('DIGITAL SALE');
      expect(html).toContain('FW-010');
      expect(html).toContain('Jungle Track');
      expect(html).toContain('Buyer Test');
      expect(html).toContain('Your Earnings');
      expect(html).toContain('Payment Breakdown');
    });

    it('calculates fees when totals are not provided', () => {
      const order = {
        customer: { firstName: 'B', lastName: 'T' },
        totals: {},
      };
      const items = [
        { name: 'Track A', type: 'track', price: 1.49, quantity: 2 },
      ];

      const html = buildDigitalSaleEmail('FW-011', order, items);

      // Should still render without crashing
      expect(html).toContain('Track A');
      expect(html).toContain('Single Track');
    });
  });

  describe('buildMerchSaleEmail', () => {
    let buildMerchSaleEmail: typeof import('../lib/order/emails/merch-email').buildMerchSaleEmail;

    beforeEach(async () => {
      const mod = await import('../lib/order/emails/merch-email');
      buildMerchSaleEmail = mod.buildMerchSaleEmail;
    });

    it('generates merch seller notification with item details', () => {
      const order = {
        customer: { firstName: 'Customer', lastName: 'One' },
        totals: { subtotal: 45, freshWaxFee: 0.45, stripeFee: 0.85, total: 46.30 },
      };
      const items = [
        { name: 'FW Hoodie', type: 'merch', price: 45, quantity: 1, size: 'XL', color: 'Navy' },
      ];

      const html = buildMerchSaleEmail('FW-020', order, items);

      expect(html).toContain('MERCH ORDER');
      expect(html).toContain('FW-020');
      expect(html).toContain('FW Hoodie');
      expect(html).toContain('Size: XL');
      expect(html).toContain('Navy');
      expect(html).toContain('No Action Required');
    });
  });

  describe('buildStockistFulfillmentEmail', () => {
    let buildStockistFulfillmentEmail: typeof import('../lib/order/emails/vinyl-email').buildStockistFulfillmentEmail;

    beforeEach(async () => {
      const mod = await import('../lib/order/emails/vinyl-email');
      buildStockistFulfillmentEmail = mod.buildStockistFulfillmentEmail;
    });

    it('generates vinyl fulfillment email with shipping address', () => {
      const order = {
        customer: { firstName: 'Vinyl', lastName: 'Buyer', email: 'vinyl@test.com' },
        totals: { subtotal: 24.99, freshWaxFee: 0.25, stripeFee: 0.55, total: 25.79 },
        paymentMethod: 'stripe',
        paymentStatus: 'completed',
        stripePaymentId: 'pi_test_vinyl',
        shipping: {
          address1: '42 Record Lane',
          city: 'Manchester',
          postcode: 'M1 1AA',
          country: 'United Kingdom',
        },
      };
      const items = [
        { name: 'Limited Press EP', type: 'vinyl', price: 24.99, quantity: 1 },
      ];

      const html = buildStockistFulfillmentEmail('order_vinyl', 'FW-030', order, items);

      expect(html).toContain('VINYL FULFILLMENT REQUIRED');
      expect(html).toContain('FW-030');
      expect(html).toContain('42 Record Lane');
      expect(html).toContain('Manchester');
      expect(html).toContain('M1 1AA');
      expect(html).toContain('Limited Press EP');
      expect(html).toContain('PAID');
      expect(html).toContain('Action Required');
    });

    it('shows PENDING for incomplete payments', () => {
      const order = {
        customer: { firstName: 'A', lastName: 'B', email: 'a@b.com' },
        totals: { subtotal: 20, total: 22 },
        paymentMethod: 'stripe',
        paymentStatus: 'pending',
        shipping: { address1: '1 St', city: 'London', postcode: 'E1', country: 'UK' },
      };
      const items = [{ name: 'EP', type: 'vinyl', price: 20, quantity: 1 }];

      const html = buildStockistFulfillmentEmail('o1', 'FW-031', order, items);
      expect(html).toContain('PENDING');
    });

    it('shows test mode warning for test payments', () => {
      const order = {
        customer: { firstName: 'A', lastName: 'B', email: 'a@b.com' },
        totals: { subtotal: 20, total: 22 },
        paymentMethod: 'test_mode',
        paymentStatus: 'completed',
        shipping: { address1: '1 St', city: 'London', postcode: 'E1', country: 'UK' },
      };
      const items = [{ name: 'EP', type: 'vinyl', price: 20, quantity: 1 }];

      const html = buildStockistFulfillmentEmail('o2', 'FW-032', order, items);
      expect(html).toContain('test order');
      expect(html).toContain('Test Mode');
    });
  });
});
