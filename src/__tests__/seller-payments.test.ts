import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared BEFORE importing the module under test
// ---------------------------------------------------------------------------

// Mock firebase-rest
const mockGetDocument = vi.fn();
const mockAddDocument = vi.fn();
const mockUpdateDocument = vi.fn();
const mockAtomicIncrement = vi.fn();
vi.mock('../lib/firebase-rest', () => ({
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
  addDocument: (...args: unknown[]) => mockAddDocument(...args),
  updateDocument: (...args: unknown[]) => mockUpdateDocument(...args),
  atomicIncrement: (...args: unknown[]) => mockAtomicIncrement(...args),
}));

// Mock api-utils
vi.mock('../lib/api-utils', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock Stripe SDK
const mockTransfersCreate = vi.fn();
vi.mock('stripe', () => {
  return {
    default: function MockStripe() {
      return {
        transfers: { create: (...args: unknown[]) => mockTransfersCreate(...args) },
      };
    },
  };
});

// Mock paypal-payouts
const mockCreatePayout = vi.fn();
const mockGetPayPalConfig = vi.fn();
vi.mock('../lib/paypal-payouts', () => ({
  createPayout: (...args: unknown[]) => mockCreatePayout(...args),
  getPayPalConfig: (...args: unknown[]) => mockGetPayPalConfig(...args),
}));

// ---------------------------------------------------------------------------
// Import modules under test AFTER mocks
// ---------------------------------------------------------------------------
import { processArtistPayments } from '../lib/order/seller-payments/artist-payments';
import { processMerchSupplierPayments } from '../lib/order/seller-payments/merch-payments';
import type { SellerPaymentParams } from '../lib/order/seller-payments/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBaseParams(overrides: Partial<SellerPaymentParams> = {}): SellerPaymentParams {
  return {
    orderId: 'order_test_123',
    orderNumber: 'FW-TEST-001',
    items: [],
    totalItemCount: 1,
    orderSubtotal: 10,
    stripeSecretKey: 'sk_test_key',
    env: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: Artist Payments
// ---------------------------------------------------------------------------
describe('processArtistPayments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddDocument.mockResolvedValue({ id: 'payout_123' });
    mockUpdateDocument.mockResolvedValue(undefined);
    mockAtomicIncrement.mockResolvedValue(undefined);
  });

  it('skips merch items — only processes digital/vinyl releases', async () => {
    const items = [
      { id: 'merch_1', name: 'T-Shirt', type: 'merch', price: 25, quantity: 1 },
    ];

    // No release or artist docs should be fetched for merch
    mockGetDocument.mockResolvedValue(null);

    await processArtistPayments(makeBaseParams({
      items,
      totalItemCount: 1,
      orderSubtotal: 25,
    }));

    // addDocument should NOT be called since all items are merch
    expect(mockAddDocument).not.toHaveBeenCalled();
  });

  it('calculates artist share: 1% Fresh Wax fee + processing fee deducted', async () => {
    const items = [
      { id: 'release_1', name: 'Jungle EP', type: 'digital', price: 10, quantity: 1, artistId: 'artist_1' },
    ];

    // Mock release lookup
    mockGetDocument.mockImplementation(async (collection: string, id: string) => {
      if (collection === 'releases' && id === 'release_1') {
        return { artistId: 'artist_1', artistName: 'DJ Test', artistEmail: 'dj@test.com' };
      }
      if (collection === 'artists' && id === 'artist_1') {
        return { artistName: 'DJ Test', email: 'dj@test.com' };
      }
      return null;
    });

    await processArtistPayments(makeBaseParams({
      items,
      totalItemCount: 1,
      orderSubtotal: 10,
    }));

    expect(mockAddDocument).toHaveBeenCalledTimes(1);
    const payoutDoc = mockAddDocument.mock.calls[0];
    expect(payoutDoc[0]).toBe('pendingPayouts');

    const data = payoutDoc[1];
    expect(data.artistId).toBe('artist_1');
    expect(data.status).toBe('pending');

    // Verify calculation:
    // itemTotal = 10 * 1 = 10
    // freshWaxFee = 10 * 0.01 = 0.10
    // totalProcessingFee = (10 * 0.014) + 0.20 = 0.14 + 0.20 = 0.34
    // processingFeePerSeller = 0.34 / 1 = 0.34
    // artistShare = 10 - 0.10 - 0.34 = 9.56
    expect(data.amount).toBeCloseTo(9.56, 2);
  });

  it('splits processing fee among multiple sellers', async () => {
    const items = [
      { id: 'release_1', name: 'Track A', type: 'digital', price: 10, quantity: 1, artistId: 'artist_1' },
      { id: 'release_2', name: 'Track B', type: 'digital', price: 10, quantity: 1, artistId: 'artist_2' },
    ];

    mockGetDocument.mockImplementation(async (collection: string, id: string) => {
      if (collection === 'releases') {
        return { artistId: id.replace('release_', 'artist_'), artistName: 'Artist', artistEmail: 'a@test.com' };
      }
      if (collection === 'artists') {
        return { artistName: 'Artist', email: 'a@test.com' };
      }
      return null;
    });

    await processArtistPayments(makeBaseParams({
      items,
      totalItemCount: 2,
      orderSubtotal: 20,
    }));

    // Two separate artist payouts
    expect(mockAddDocument).toHaveBeenCalledTimes(2);

    // Verify each gets half the processing fee:
    // totalProcessingFee = (20 * 0.014) + 0.20 = 0.28 + 0.20 = 0.48
    // processingFeePerSeller = 0.48 / 2 = 0.24
    // freshWaxFee per item = 10 * 0.01 = 0.10
    // artistShare per item = 10 - 0.10 - 0.24 = 9.66
    for (const call of mockAddDocument.mock.calls) {
      expect(call[1].amount).toBeCloseTo(9.66, 2);
    }
  });

  it('groups multiple items from the same artist into one payout', async () => {
    const items = [
      { id: 'release_1', name: 'Track A', type: 'digital', price: 5, quantity: 1, artistId: 'artist_1' },
      { id: 'release_2', name: 'Track B', type: 'digital', price: 8, quantity: 1, artistId: 'artist_1' },
    ];

    mockGetDocument.mockImplementation(async (collection: string) => {
      if (collection === 'releases') {
        return { artistId: 'artist_1', artistName: 'DJ Test', artistEmail: 'dj@test.com' };
      }
      if (collection === 'artists') {
        return { artistName: 'DJ Test', email: 'dj@test.com' };
      }
      return null;
    });

    await processArtistPayments(makeBaseParams({
      items,
      totalItemCount: 2,
      orderSubtotal: 13,
    }));

    // One combined payout for the same artist (not two separate ones)
    expect(mockAddDocument).toHaveBeenCalledTimes(1);
    const payout = mockAddDocument.mock.calls[0][1];
    expect(payout.artistId).toBe('artist_1');
    // Total should be sum of both artist shares
    // Item 1: 5 - 0.05 - processingFeePerSeller
    // Item 2: 8 - 0.08 - processingFeePerSeller
    // totalProcessingFee = (13 * 0.014) + 0.20 = 0.182 + 0.20 = 0.382
    // processingFeePerSeller = 0.382 / 2 = 0.191
    // share1 = 5 - 0.05 - 0.191 = 4.759
    // share2 = 8 - 0.08 - 0.191 = 7.729
    // total = 12.488
    expect(payout.amount).toBeCloseTo(12.488, 2);
  });

  it('updates artist pending balance atomically after payout creation', async () => {
    const items = [
      { id: 'release_1', name: 'Track', type: 'digital', price: 10, quantity: 1, artistId: 'artist_1' },
    ];

    mockGetDocument.mockImplementation(async (collection: string) => {
      if (collection === 'releases') return { artistId: 'artist_1', artistName: 'DJ', artistEmail: 'dj@test.com' };
      if (collection === 'artists') return { artistName: 'DJ', email: 'dj@test.com' };
      return null;
    });

    await processArtistPayments(makeBaseParams({
      items,
      totalItemCount: 1,
      orderSubtotal: 10,
    }));

    expect(mockAtomicIncrement).toHaveBeenCalledWith('artists', 'artist_1', {
      pendingBalance: expect.closeTo(9.56, 1),
    });
    expect(mockUpdateDocument).toHaveBeenCalledWith('artists', 'artist_1', expect.objectContaining({
      updatedAt: expect.any(String),
    }));
  });

  it('skips payout for zero or negative artist share', async () => {
    // Price is so low that after fees the share is <= 0
    const items = [
      { id: 'release_1', name: 'Cheap Track', type: 'digital', price: 0.01, quantity: 1, artistId: 'artist_1' },
    ];

    mockGetDocument.mockImplementation(async (collection: string) => {
      if (collection === 'releases') return { artistId: 'artist_1', artistName: 'DJ', artistEmail: 'dj@test.com' };
      if (collection === 'artists') return { artistName: 'DJ', email: 'dj@test.com' };
      return null;
    });

    await processArtistPayments(makeBaseParams({
      items,
      totalItemCount: 1,
      orderSubtotal: 0.01,
    }));

    // The amount would be: 0.01 - 0.0001 - ((0.01 * 0.014 + 0.20) / 1) = 0.01 - 0.0001 - 0.20014 < 0
    // So addDocument should NOT be called (payment.amount <= 0)
    expect(mockAddDocument).not.toHaveBeenCalled();
  });

  it('handles quantity > 1 correctly', async () => {
    const items = [
      { id: 'release_1', name: 'Track', type: 'digital', price: 5, quantity: 3, artistId: 'artist_1' },
    ];

    mockGetDocument.mockImplementation(async (collection: string) => {
      if (collection === 'releases') return { artistId: 'artist_1', artistName: 'DJ', artistEmail: 'dj@test.com' };
      if (collection === 'artists') return { artistName: 'DJ', email: 'dj@test.com' };
      return null;
    });

    await processArtistPayments(makeBaseParams({
      items,
      totalItemCount: 1,
      orderSubtotal: 15,
    }));

    // itemTotal = 5 * 3 = 15
    // freshWaxFee = 15 * 0.01 = 0.15
    // totalProcessingFee = (15 * 0.014) + 0.20 = 0.21 + 0.20 = 0.41
    // processingFeePerSeller = 0.41 / 1 = 0.41
    // artistShare = 15 - 0.15 - 0.41 = 14.44
    const payout = mockAddDocument.mock.calls[0][1];
    expect(payout.amount).toBeCloseTo(14.44, 2);
  });

  it('continues if atomicIncrement fails (non-fatal)', async () => {
    const items = [
      { id: 'release_1', name: 'Track', type: 'digital', price: 10, quantity: 1, artistId: 'artist_1' },
    ];

    mockGetDocument.mockImplementation(async (collection: string) => {
      if (collection === 'releases') return { artistId: 'artist_1', artistName: 'DJ', artistEmail: 'dj@test.com' };
      if (collection === 'artists') return { artistName: 'DJ', email: 'dj@test.com' };
      return null;
    });

    mockAtomicIncrement.mockRejectedValue(new Error('Firebase timeout'));

    // Should not throw — atomicIncrement failure is caught internally
    await expect(processArtistPayments(makeBaseParams({
      items,
      totalItemCount: 1,
      orderSubtotal: 10,
    }))).resolves.toBeUndefined();

    // But the payout document was still created
    expect(mockAddDocument).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: Merch Supplier Payments
// ---------------------------------------------------------------------------
describe('processMerchSupplierPayments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddDocument.mockResolvedValue({ id: 'payout_123' });
    mockUpdateDocument.mockResolvedValue(undefined);
    mockAtomicIncrement.mockResolvedValue(undefined);
    mockGetPayPalConfig.mockReturnValue({ clientId: 'test', secret: 'test', mode: 'sandbox' });
  });

  it('skips entirely when no merch items are present', async () => {
    const items = [
      { id: 'release_1', name: 'Digital Track', type: 'digital', price: 10, quantity: 1 },
    ];

    await processMerchSupplierPayments(makeBaseParams({
      items,
      totalItemCount: 1,
      orderSubtotal: 10,
    }));

    expect(mockGetDocument).not.toHaveBeenCalled();
    expect(mockAddDocument).not.toHaveBeenCalled();
  });

  it('calculates merch supplier share: 5% Fresh Wax fee + processing fee deducted', async () => {
    const items = [
      { id: 'merch_1', name: 'Hoodie', type: 'merch', price: 40, quantity: 1, productId: 'prod_1' },
    ];

    mockGetDocument.mockImplementation(async (collection: string, id: string) => {
      if (collection === 'merch' && id === 'prod_1') {
        return { supplierId: 'supplier_1', name: 'Hoodie' };
      }
      if (collection === 'merch-suppliers' && id === 'supplier_1') {
        return {
          name: 'Test Supplier',
          email: 'supplier@test.com',
          stripeConnectId: 'acct_test_123',
          payoutMethod: 'stripe',
        };
      }
      return null;
    });

    mockTransfersCreate.mockResolvedValue({ id: 'tr_test_123' });

    await processMerchSupplierPayments(makeBaseParams({
      items,
      totalItemCount: 1,
      orderSubtotal: 40,
    }));

    // Verify calculation:
    // itemTotal = 40 * 1 = 40
    // freshWaxFee = 40 * 0.05 = 2.00 (5% for merch, not 1%)
    // totalProcessingFee = (40 * 0.014) + 0.20 = 0.56 + 0.20 = 0.76
    // processingFeePerSeller = 0.76 / 1 = 0.76
    // supplierShare = 40 - 2.00 - 0.76 = 37.24

    expect(mockTransfersCreate).toHaveBeenCalledTimes(1);
    const transferArgs = mockTransfersCreate.mock.calls[0][0];
    expect(transferArgs.amount).toBe(Math.round(37.24 * 100)); // 3724 pence
    expect(transferArgs.currency).toBe('gbp');
    expect(transferArgs.destination).toBe('acct_test_123');
  });

  it('uses skipStripeTransfers to prevent actual transfers', async () => {
    const items = [
      { id: 'merch_1', name: 'Cap', type: 'merch', price: 20, quantity: 1, productId: 'prod_1' },
    ];

    mockGetDocument.mockImplementation(async (collection: string) => {
      if (collection === 'merch') return { supplierId: 'supplier_1' };
      if (collection === 'merch-suppliers') return { name: 'Supplier', email: 's@test.com', stripeConnectId: 'acct_1', payoutMethod: 'stripe' };
      return null;
    });

    await processMerchSupplierPayments({
      ...makeBaseParams({ items, totalItemCount: 1, orderSubtotal: 20 }),
      skipStripeTransfers: true,
    });

    // Should NOT create any transfers or payout documents
    expect(mockTransfersCreate).not.toHaveBeenCalled();
    expect(mockAddDocument).not.toHaveBeenCalled();
  });

  it('creates pending payout when supplier has no payout method', async () => {
    const items = [
      { id: 'merch_1', name: 'Vinyl Bag', type: 'merch', price: 15, quantity: 1, productId: 'prod_1' },
    ];

    mockGetDocument.mockImplementation(async (collection: string) => {
      if (collection === 'merch') return { supplierId: 'supplier_1' };
      if (collection === 'merch-suppliers') {
        return {
          name: 'New Supplier',
          email: 'new@test.com',
          stripeConnectId: null,
          paypalEmail: null,
          payoutMethod: null,
        };
      }
      return null;
    });

    await processMerchSupplierPayments(makeBaseParams({
      items,
      totalItemCount: 1,
      orderSubtotal: 15,
    }));

    expect(mockAddDocument).toHaveBeenCalledWith('pendingSupplierPayouts', expect.objectContaining({
      status: 'awaiting_connect',
      supplierId: 'supplier_1',
      notificationSent: false,
    }));
  });

  it('creates pending retry payout when Stripe transfer fails', async () => {
    const items = [
      { id: 'merch_1', name: 'Hoodie', type: 'merch', price: 40, quantity: 1, productId: 'prod_1' },
    ];

    mockGetDocument.mockImplementation(async (collection: string) => {
      if (collection === 'merch') return { supplierId: 'supplier_1' };
      if (collection === 'merch-suppliers') {
        return {
          name: 'Test Supplier',
          email: 'supplier@test.com',
          stripeConnectId: 'acct_test_123',
          payoutMethod: 'stripe',
        };
      }
      return null;
    });

    mockTransfersCreate.mockRejectedValue(new Error('Stripe Connect error'));

    await processMerchSupplierPayments(makeBaseParams({
      items,
      totalItemCount: 1,
      orderSubtotal: 40,
    }));

    // Should create a pending payout with retry_pending status
    expect(mockAddDocument).toHaveBeenCalledWith('pendingSupplierPayouts', expect.objectContaining({
      status: 'retry_pending',
      failureReason: 'Stripe Connect error',
      supplierId: 'supplier_1',
    }));
  });

  it('uses PayPal when supplier prefers PayPal and deducts 2% payout fee', async () => {
    const items = [
      { id: 'merch_1', name: 'Sticker Pack', type: 'merch', price: 10, quantity: 2, productId: 'prod_1' },
    ];

    mockGetDocument.mockImplementation(async (collection: string) => {
      if (collection === 'merch') return { supplierId: 'supplier_1' };
      if (collection === 'merch-suppliers') {
        return {
          name: 'PayPal Supplier',
          email: 'ppsupplier@test.com',
          paypalEmail: 'ppsupplier@paypal.com',
          payoutMethod: 'paypal',
          stripeConnectId: null,
        };
      }
      return null;
    });

    mockCreatePayout.mockResolvedValue({ success: true, batchId: 'batch_123' });

    await processMerchSupplierPayments(makeBaseParams({
      items,
      totalItemCount: 1,
      orderSubtotal: 20,
    }));

    // supplierShare = 20 - (20*0.05) - ((20*0.014+0.20)/1) = 20 - 1.0 - 0.48 = 18.52
    // paypalPayoutFee = 18.52 * 0.02 = 0.3704
    // paypalAmount = 18.52 - 0.3704 = 18.1496
    expect(mockCreatePayout).toHaveBeenCalledTimes(1);
    const payoutArgs = mockCreatePayout.mock.calls[0][1];
    expect(payoutArgs.email).toBe('ppsupplier@paypal.com');
    expect(payoutArgs.amount).toBeCloseTo(18.1496, 2);
    expect(payoutArgs.currency).toBe('GBP');

    // Successful payout should record supplierPayouts doc
    expect(mockAddDocument).toHaveBeenCalledWith('supplierPayouts', expect.objectContaining({
      payoutMethod: 'paypal',
      status: 'completed',
    }));
  });
});
