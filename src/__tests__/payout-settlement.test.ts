// Tests for settlePendingArtistRows — the settlement engine behind Mark as
// Paid and admin PayPal payouts. Rows are the source of truth: settlement
// must use the row's artistId and amount (postage included), scope to one
// artist when asked, and keep pendingBalance/totalEarnings in sync.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQueryCollection = vi.fn();
const mockAddDocument = vi.fn();
const mockUpdateDocument = vi.fn();
const mockAtomicIncrement = vi.fn();
vi.mock('../lib/firebase-rest', () => ({
  queryCollection: (...args: unknown[]) => mockQueryCollection(...args),
  addDocument: (...args: unknown[]) => mockAddDocument(...args),
  updateDocument: (...args: unknown[]) => mockUpdateDocument(...args),
  atomicIncrement: (...args: unknown[]) => mockAtomicIncrement(...args),
}));

vi.mock('../lib/api-utils', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { settlePendingArtistRows } from '../lib/payout-settlement';

const hangryRow = {
  id: 'row_hangry',
  artistId: 'uid_hangry',
  artistName: 'Hangry Records',
  artistEmail: 'hangry@test.com',
  orderId: 'order_1',
  orderNumber: 'FW-001',
  amount: 19.26,
  itemAmount: 14.27,
  shippingAmount: 4.99,
  currency: 'gbp',
  status: 'pending',
};

describe('settlePendingArtistRows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddDocument.mockResolvedValue({ id: 'payout_1' });
    mockUpdateDocument.mockResolvedValue(undefined);
    mockAtomicIncrement.mockResolvedValue(undefined);
  });

  it('requires a scope', async () => {
    await expect(settlePendingArtistRows({ method: 'manual' })).rejects.toThrow();
  });

  it('queries only payable statuses, scoped to order + artist', async () => {
    mockQueryCollection.mockResolvedValue([]);
    await settlePendingArtistRows({ orderId: 'order_1', artistId: 'uid_hangry', method: 'manual' });

    const [collection, opts] = mockQueryCollection.mock.calls[0];
    expect(collection).toBe('pendingPayouts');
    const filters = opts.filters as Array<{ field: string; op: string; value: unknown }>;
    expect(filters).toContainEqual({ field: 'orderId', op: 'EQUAL', value: 'order_1' });
    expect(filters).toContainEqual({ field: 'artistId', op: 'EQUAL', value: 'uid_hangry' });
    const statusFilter = filters.find((f) => f.field === 'status');
    expect(statusFilter?.op).toBe('IN');
    expect(statusFilter?.value).toEqual(['pending', 'awaiting_connect', 'retry_pending']);
  });

  it('settles from the ROW: exact amount, real uid, postage preserved', async () => {
    mockQueryCollection.mockResolvedValue([hangryRow]);

    const result = await settlePendingArtistRows({ orderId: 'order_1', method: 'manual', notes: 'paid by bank' });

    expect(result.settled).toBe(1);
    expect(result.totalAmount).toBeCloseTo(19.26, 2);

    const [collection, record] = mockAddDocument.mock.calls[0];
    expect(collection).toBe('payouts');
    expect(record.artistId).toBe('uid_hangry'); // the uid, never the display name
    expect(record.amount).toBeCloseTo(19.26, 2); // row amount, never recomputed
    expect(record.shippingAmount).toBeCloseTo(4.99, 2);
    expect(record.itemAmount).toBeCloseTo(14.27, 2);
    expect(record.payoutMethod).toBe('manual');
    expect(record.status).toBe('completed');
    expect(record.fromPendingPayout).toBe('row_hangry');

    // Row flipped to completed
    const rowUpdate = mockUpdateDocument.mock.calls.find((c) => c[0] === 'pendingPayouts');
    expect(rowUpdate![1]).toBe('row_hangry');
    expect(rowUpdate![2].status).toBe('completed');

    // Balances kept in sync
    const [incCollection, incId, incFields] = mockAtomicIncrement.mock.calls[0];
    expect(incCollection).toBe('artists');
    expect(incId).toBe('uid_hangry');
    expect(incFields.pendingBalance).toBeCloseTo(-19.26, 2);
    expect(incFields.totalEarnings).toBeCloseTo(19.26, 2);
  });

  it('stamps extra fields (e.g. PayPal batch) onto the history record', async () => {
    mockQueryCollection.mockResolvedValue([hangryRow]);

    await settlePendingArtistRows({
      orderId: 'order_1',
      artistId: 'uid_hangry',
      method: 'paypal',
      extra: { paypalBatchId: 'BATCH123', paypalPayoutFee: 0.39 },
    });

    const record = mockAddDocument.mock.calls[0][1];
    expect(record.payoutMethod).toBe('paypal');
    expect(record.paypalBatchId).toBe('BATCH123');
    expect(record.paypalPayoutFee).toBeCloseTo(0.39, 2);
  });

  it('skips rows without an artistId or with non-positive amounts, settling the rest', async () => {
    mockQueryCollection.mockResolvedValue([
      { ...hangryRow },
      { id: 'row_broken', orderId: 'order_1', amount: 5, status: 'pending' }, // no artistId
      { id: 'row_zero', artistId: 'uid_x', orderId: 'order_1', amount: 0, status: 'pending' },
    ]);

    const result = await settlePendingArtistRows({ orderId: 'order_1', method: 'manual' });

    expect(result.settled).toBe(1);
    expect(result.skipped).toBe(2);
    expect(mockAddDocument).toHaveBeenCalledTimes(1);
    expect(mockAtomicIncrement).toHaveBeenCalledTimes(1);
  });

  it('a failed balance update does not undo the settlement', async () => {
    mockQueryCollection.mockResolvedValue([hangryRow]);
    mockAtomicIncrement.mockRejectedValue(new Error('firestore blip'));

    const result = await settlePendingArtistRows({ orderId: 'order_1', method: 'manual' });

    expect(result.settled).toBe(1);
    const rowUpdate = mockUpdateDocument.mock.calls.find((c) => c[0] === 'pendingPayouts');
    expect(rowUpdate![2].status).toBe('completed');
  });
});
