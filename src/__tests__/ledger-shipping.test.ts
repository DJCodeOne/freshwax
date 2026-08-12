import { describe, it, expect, vi, beforeEach } from 'vitest';

// The ledger hardcoded `shipping: 0`, so its artistPayout under-stated the real
// payout by exactly the postage on every physical sale. These lock the ledger
// to the payout figure.
const addDocument = vi.fn(async () => ({ id: 'ledger_1' }));
vi.mock('../lib/firebase-rest', () => ({
  addDocument: (...a: unknown[]) => addDocument(...a),
}));
vi.mock('../lib/d1/ledger', () => ({ d1InsertLedgerEntry: vi.fn(async () => undefined) }));

const { recordMultiSellerSale } = await import('../lib/sales-ledger');

const ARTIST = 'HVXl6a4BQ7WmSw4QemNP76Qnktm2';

/** The real Stamp Series Vol 1 sale: £12 record + £4.99 postage. */
function vinylSale(over: Record<string, unknown> = {}) {
  return {
    orderId: 'order_1',
    orderNumber: 'FW-260812-LWJEJU',
    customerEmail: 'buyer@test.com',
    grossTotal: 16.99,
    shipping: 4.99,
    stripeFee: 0.52,
    freshWaxFee: 0.12,
    paymentMethod: 'stripe' as const,
    artistShippingBreakdown: {
      [ARTIST]: { artistId: ARTIST, artistName: 'Drum Unit Recordings', amount: 4.99 },
    },
    items: [{
      releaseId: 'drum_unit_recordings_FW-1786529398020',
      title: 'Stamp Series Vol 1',
      type: 'vinyl',
      price: 12,
      quantity: 1,
      submitterId: ARTIST,
      artist: 'Drum Unit Recordings',
    }],
    ...over,
  };
}

const entries = () => addDocument.mock.calls.map(c => c[1] as Record<string, number>);

beforeEach(() => addDocument.mockClear());

describe('sales ledger records the seller postage', () => {
  it('records shipping instead of zero', async () => {
    await recordMultiSellerSale(vinylSale() as never);
    expect(entries()[0].shipping).toBe(4.99);
  });

  it('grossTotal is items + postage, matching what the customer paid', async () => {
    await recordMultiSellerSale(vinylSale() as never);
    const e = entries()[0];
    expect(e.subtotal).toBe(12);
    expect(e.grossTotal).toBe(16.99);
  });

  it('artistPayout matches the real payout figure (was £11.36, should be £16.35)', async () => {
    await recordMultiSellerSale(vinylSale() as never);
    const e = entries()[0];
    // 12.00 + 4.99 − 0.52 stripe − 0.12 freshwax
    expect(e.artistPayout).toBeCloseTo(16.35, 2);
    expect(e.netRevenue).toBeCloseTo(16.35, 2);
  });

  it('leaves fees untouched — postage is not fee-free, it rides the same total', async () => {
    await recordMultiSellerSale(vinylSale() as never);
    const e = entries()[0];
    expect(e.stripeFee).toBeCloseTo(0.52, 2);
    expect(e.freshWaxFee).toBeCloseTo(0.12, 2);
    expect(e.totalFees).toBeCloseTo(0.64, 2);
  });

  it('conserves value: grossTotal − totalFees === artistPayout', async () => {
    await recordMultiSellerSale(vinylSale() as never);
    const e = entries()[0];
    expect(e.grossTotal - e.totalFees).toBeCloseTo(e.artistPayout, 2);
  });

  it('records zero shipping for a digital-only sale', async () => {
    await recordMultiSellerSale(vinylSale({
      grossTotal: 3, shipping: 0, artistShippingBreakdown: null, stripeFee: 0.24, freshWaxFee: 0.03,
      items: [{ releaseId: 'r1', title: 'Stamp Series Vol 1', type: 'digital', price: 3, quantity: 1, submitterId: ARTIST }],
    }) as never);
    const e = entries()[0];
    expect(e.shipping).toBe(0);
    expect(e.grossTotal).toBe(3);
  });

  it('gives each artist only their own postage in a multi-seller order', async () => {
    const OTHER = 'other-artist-uid';
    await recordMultiSellerSale(vinylSale({
      grossTotal: 36.98, shipping: 9.98, stripeFee: 0.72, freshWaxFee: 0.27,
      artistShippingBreakdown: {
        [ARTIST]: { artistId: ARTIST, artistName: 'Drum Unit', amount: 4.99 },
        [OTHER]: { artistId: OTHER, artistName: 'Other Label', amount: 4.99 },
      },
      items: [
        { releaseId: 'r1', title: 'A', type: 'vinyl', price: 12, quantity: 1, submitterId: ARTIST },
        { releaseId: 'r2', title: 'B', type: 'vinyl', price: 15, quantity: 1, submitterId: OTHER },
      ],
    }) as never);
    const all = entries();
    expect(all).toHaveLength(2);
    for (const e of all) expect(e.shipping).toBe(4.99);
    // Postage total is conserved across sellers
    expect(all.reduce((s, e) => s + e.shipping, 0)).toBeCloseTo(9.98, 2);
  });

  it('records zero postage for a seller absent from the breakdown', async () => {
    // e.g. platform-shipped merch alongside artist-shipped vinyl
    await recordMultiSellerSale(vinylSale({
      artistShippingBreakdown: { 'someone-else': { artistId: 'someone-else', artistName: 'X', amount: 4.99 } },
    }) as never);
    expect(entries()[0].shipping).toBe(0);
  });
});
