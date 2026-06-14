// src/__tests__/payout-accounting.test.ts
//
// END-TO-END PAYOUT ACCOUNTING VERIFICATION (no real payment).
//
// Runs a single representative multi-seller order through the REAL shipping
// rules (computeReleaseVinylShipping + applyCrateCombinedShipping) and the REAL
// payout fan-out (processArtistPayments + processVinylCrateSellerPayments +
// processMerchSupplierPayments) with the Firestore/D1/Stripe/PayPal layers
// mocked so every write is captured instead of executed.
//
// The order exercises every payout path at once:
//   - a split-ownership vinyl RELEASE (payoutSplits 50/50, qty 2 → +50p additional)
//   - a digital release (single artist, no shipping)
//   - two CRATE records from one seller (combined shipping: single + 50p)
//   - a consignment MERCH item (supplier ~98% share)
//
// It then asserts the books balance to the penny:
//   buyer charge === Σ seller payouts + FreshWax 1% fee + processor fee + merch postage kept
// and that each payout record is internally consistent (amount = item + shipping)
// and synced to the right collection / balance counter.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock the persistence + processor layers ------------------------------
const mockGetDocument = vi.fn();
const mockAddDocument = vi.fn();
const mockUpdateDocument = vi.fn();
const mockAtomicIncrement = vi.fn();
vi.mock('../lib/firebase-rest', () => ({
  getDocument: (...a: unknown[]) => mockGetDocument(...a),
  addDocument: (...a: unknown[]) => mockAddDocument(...a),
  updateDocument: (...a: unknown[]) => mockUpdateDocument(...a),
  atomicIncrement: (...a: unknown[]) => mockAtomicIncrement(...a),
}));
vi.mock('../lib/api-utils', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
// d1-catalog: shipping-rules imports d1GetVinylSeller; we pass db=undefined so
// it's never invoked, but the module must still resolve.
vi.mock('../lib/d1-catalog', () => ({
  d1GetVinylSeller: vi.fn(async () => null),
  d1RecordRoyalty: vi.fn(async () => undefined),
}));
const mockTransfersCreate = vi.fn();
vi.mock('stripe', () => ({
  default: function MockStripe() {
    return { transfers: { create: (...a: unknown[]) => mockTransfersCreate(...a) } };
  },
}));
vi.mock('../lib/paypal-payouts', () => ({
  createPayout: vi.fn(),
  // Return null so crate/merch sellers route through the (mocked) Stripe path.
  getPayPalConfig: vi.fn(() => null),
}));

import { processArtistPayments } from '../lib/order/seller-payments/artist-payments';
import { processVinylCrateSellerPayments } from '../lib/order/seller-payments/vinyl-payments';
import { processMerchSupplierPayments } from '../lib/order/seller-payments/merch-payments';
import {
  computeReleaseVinylShipping,
  applyCrateCombinedShipping,
  regionForCountry,
} from '../lib/order/shipping-rules';

// --- Reference Firestore documents the order resolves against -------------
const RELEASES: Record<string, Record<string, unknown>> = {
  rel_split: {
    artistId: 'codeone', artistName: 'Code One', artistEmail: 'code@fw.uk',
    // 50/50 split-ownership EP (Code One & Bakkus)
    payoutSplits: [{ artistId: 'codeone', percentage: 50 }, { artistId: 'bakkus', percentage: 50 }],
  },
  rel_dig: { artistId: 'ulair', artistName: 'Underground Lair', artistEmail: 'ul@fw.uk' },
};
const ARTISTS: Record<string, Record<string, unknown>> = {
  codeone: { artistName: 'Code One', email: 'code@fw.uk' },
  bakkus: { artistName: 'Bakkus', email: 'bakkus@fw.uk' },
  ulair: { artistName: 'Underground Lair', email: 'ul@fw.uk' },
};
const USERS: Record<string, Record<string, unknown>> = {
  krotos: { displayName: 'Krotos', email: 'krotos@fw.uk', stripeConnectId: 'acct_krotos', payoutMethod: 'stripe' },
};
const MERCH: Record<string, Record<string, unknown>> = {
  prod_tee: { supplierId: 'sup_x', name: 'Tee' },
};
const SUPPLIERS: Record<string, Record<string, unknown>> = {
  sup_x: { name: 'Supplier X', email: 'sup@fw.uk', stripeConnectId: 'acct_supx', payoutMethod: 'stripe' },
};

function wireFirestore() {
  mockGetDocument.mockImplementation(async (collection: string, id: string) => {
    if (collection === 'releases') return RELEASES[id] || null;
    if (collection === 'artists') return ARTISTS[id] || null;
    if (collection === 'users') return USERS[id] || null;
    if (collection === 'merch') return MERCH[id] || null;
    if (collection === 'merch-suppliers') return SUPPLIERS[id] || null;
    if (collection === 'vinyl-sellers') return null; // no custom additional / no free-shipping
    return null;
  });
  mockAddDocument.mockResolvedValue({ id: 'doc_x' });
  mockUpdateDocument.mockResolvedValue(undefined);
  mockAtomicIncrement.mockResolvedValue(undefined);
  mockTransfersCreate.mockResolvedValue({ id: 'tr_x' });
}

const round2 = (n: number) => Math.round(n * 100) / 100;

describe('payout accounting — full multi-seller order conservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wireFirestore();
  });

  it('balances buyer charge against every payout + fees + retained postage', async () => {
    const region = regionForCountry('United Kingdom');
    expect(region).toBe('UK');

    // The basket (server-validated prices already applied).
    const items: Record<string, unknown>[] = [
      // Split-ownership vinyl release, 2 copies → +50p for the 2nd record
      { id: 'rel_split', releaseId: 'rel_split', type: 'vinyl', name: 'Split EP', price: 12, quantity: 2,
        artistId: 'codeone', vinylShippingUK: 4.99, vinylShippingAdditional: 0.5 },
      // Digital release (no shipping)
      { id: 'rel_dig', releaseId: 'rel_dig', type: 'digital', name: 'Digital Track', price: 8, quantity: 1, artistId: 'ulair' },
      // Two crate records from one seller → combined postage
      { id: 'list_c1', type: 'vinyl', name: 'Crate A', price: 10, quantity: 1, sellerId: 'krotos', cratesShippingCost: 4.99 },
      { id: 'list_c2', type: 'vinyl', name: 'Crate B', price: 10, quantity: 1, sellerId: 'krotos', cratesShippingCost: 4.99 },
      // Consignment merch (supplier share path)
      { id: 'prod_tee', productId: 'prod_tee', type: 'merch', name: 'Tee', price: 25, quantity: 1 },
    ];

    const itemsSubtotal = round2(items.reduce((s, i) => s + (i.price as number) * (i.quantity as number), 0));
    const totalItemCount = items.length;

    // --- Buyer-side shipping, computed by the REAL rules ------------------
    await applyCrateCombinedShipping(items as never, undefined); // mutates cratesShippingCost in place
    const crateShipping = round2(items
      .filter(i => i.type === 'vinyl' && i.sellerId && !i.releaseId)
      .reduce((s, i) => s + ((i.cratesShippingCost as number) || 0) * ((i.quantity as number) || 1), 0));
    const { total: releaseVinylShipping, breakdown: artistShippingBreakdown } =
      computeReleaseVinylShipping(items as never, region);
    const merchShipping = 4.99; // flat, kept by the platform (no supplier offers free shipping here)

    const buyerCharge = round2(itemsSubtotal + releaseVinylShipping + crateShipping + merchShipping);

    // Processor fee for the order (Stripe estimate, on the item subtotal).
    const processorFee = round2(itemsSubtotal * 0.014 + 0.20);
    const freshWaxFee = round2(itemsSubtotal * 0.01); // 1% platform fee

    const baseParams = {
      orderId: 'order_verify', orderNumber: 'FW-VERIFY-1',
      items, totalItemCount, orderSubtotal: itemsSubtotal,
      stripeSecretKey: 'sk_test', env: {} as never,
      paymentMethod: 'stripe' as const,
    };

    // --- Run the REAL payout fan-out ------------------------------------
    await processArtistPayments({ ...baseParams, artistShippingBreakdown });
    await processVinylCrateSellerPayments(baseParams);
    await processMerchSupplierPayments(baseParams);

    // --- Collect captured writes ----------------------------------------
    type Payout = { collection: string; recipient: string; amount: number; itemAmount: number; shippingAmount: number };
    const payouts: Payout[] = [];
    for (const call of mockAddDocument.mock.calls) {
      const [collection, doc] = call as [string, Record<string, unknown>];
      if (collection === 'pendingPayouts') {
        payouts.push({ collection, recipient: doc.artistId as string, amount: doc.amount as number,
          itemAmount: doc.itemAmount as number, shippingAmount: doc.shippingAmount as number });
      } else if (collection === 'crateSellerPayouts') {
        payouts.push({ collection, recipient: doc.sellerId as string, amount: doc.amount as number,
          itemAmount: doc.itemAmount as number, shippingAmount: doc.shippingAmount as number });
      } else if (collection === 'supplierPayouts') {
        payouts.push({ collection, recipient: doc.supplierId as string, amount: doc.amount as number,
          itemAmount: (doc.amount as number), shippingAmount: 0 });
      }
    }

    const totalPayouts = round2(payouts.reduce((s, p) => s + p.amount, 0));
    const totalPayoutShipping = round2(payouts.reduce((s, p) => s + p.shippingAmount, 0));

    // --- Human-readable ledger ------------------------------------------
    /* eslint-disable no-console */
    console.log('\n================ PAYOUT ACCOUNTING LEDGER ================');
    console.log('Region:', region);
    console.log('Item subtotal:        £' + itemsSubtotal.toFixed(2));
    console.log('  release vinyl ship: £' + releaseVinylShipping.toFixed(2), '(to artist)');
    console.log('  crate ship (combd): £' + crateShipping.toFixed(2), '(to seller)');
    console.log('  merch ship (flat):  £' + merchShipping.toFixed(2), '(kept by platform)');
    console.log('BUYER CHARGES:        £' + buyerCharge.toFixed(2));
    console.log('----------------------------------------------------------');
    for (const p of payouts) {
      console.log(`  ${p.collection.padEnd(18)} ${p.recipient.padEnd(9)} £${p.amount.toFixed(2)}` +
        `  (item £${p.itemAmount.toFixed(2)} + ship £${p.shippingAmount.toFixed(2)})`);
    }
    console.log('  Σ seller payouts:   £' + totalPayouts.toFixed(2));
    console.log('  FreshWax 1% fee:    £' + freshWaxFee.toFixed(2));
    console.log('  Processor fee:      £' + processorFee.toFixed(2));
    console.log('  Merch postage kept: £' + merchShipping.toFixed(2));
    const reconstructed = round2(totalPayouts + freshWaxFee + processorFee + merchShipping);
    console.log('  Σ allocation:       £' + reconstructed.toFixed(2));
    console.log('==========================================================\n');
    /* eslint-enable no-console */

    // === Assertions =====================================================

    // 1. Shipping computed by the real rules (single + 50p additional).
    expect(releaseVinylShipping).toBeCloseTo(5.49, 2); // 4.99 + 0.50
    expect(crateShipping).toBeCloseTo(5.49, 2);        // 4.99 + 0.50 (combined)

    // 2. Every payout path produced a record (5 recipients: codeone, bakkus, ulair, krotos, sup_x).
    expect(payouts.map(p => p.recipient).sort()).toEqual(['bakkus', 'codeone', 'krotos', 'sup_x', 'ulair']);

    // 3. Split-ownership: the release item share splits 50/50; release postage
    //    (5.49) rides entirely with the primary artist (the shipper).
    const codeone = payouts.find(p => p.recipient === 'codeone')!;
    const bakkus = payouts.find(p => p.recipient === 'bakkus')!;
    expect(codeone.itemAmount).toBeCloseTo(bakkus.itemAmount, 2); // equal halves
    expect(codeone.shippingAmount).toBeCloseTo(5.49, 2);
    expect(bakkus.shippingAmount).toBeCloseTo(0, 2);

    // 4. Crate seller gets 100% of the combined postage on top of item shares.
    const krotos = payouts.find(p => p.recipient === 'krotos')!;
    expect(krotos.shippingAmount).toBeCloseTo(5.49, 2);

    // 5. Each payout record is internally consistent: amount = item + shipping.
    for (const p of payouts) {
      expect(p.amount).toBeCloseTo(round2(p.itemAmount + p.shippingAmount), 2);
    }

    // 6. Shipping conservation: all release+crate postage reaches sellers; only
    //    merch postage is retained by the platform.
    expect(totalPayoutShipping).toBeCloseTo(round2(releaseVinylShipping + crateShipping), 2);

    // 7. THE BOOKS BALANCE — buyer charge is fully accounted for, to the penny.
    expect(reconstructed).toBeCloseTo(buyerCharge, 2);
  });

  it('syncs each payout to its balance counter (artist pendingBalance, crate crateEarnings, supplier transfer)', async () => {
    const items: Record<string, unknown>[] = [
      { id: 'rel_dig', releaseId: 'rel_dig', type: 'digital', name: 'Digital Track', price: 8, quantity: 1, artistId: 'ulair' },
      { id: 'list_c1', type: 'vinyl', name: 'Crate A', price: 10, quantity: 1, sellerId: 'krotos', cratesShippingCost: 4.99 },
      { id: 'prod_tee', productId: 'prod_tee', type: 'merch', name: 'Tee', price: 25, quantity: 1 },
    ];
    const baseParams = {
      orderId: 'order_sync', orderNumber: 'FW-SYNC-1',
      items, totalItemCount: items.length, orderSubtotal: 43,
      stripeSecretKey: 'sk_test', env: {} as never, paymentMethod: 'stripe' as const,
    };

    await processArtistPayments(baseParams);
    await processVinylCrateSellerPayments(baseParams);
    await processMerchSupplierPayments(baseParams);

    // Artist pending balance incremented by the payout amount.
    const artistInc = mockAtomicIncrement.mock.calls.find(c => c[0] === 'artists' && c[1] === 'ulair');
    expect(artistInc).toBeDefined();
    const ulairPayout = mockAddDocument.mock.calls.find(c => c[0] === 'pendingPayouts')![1] as Record<string, unknown>;
    expect((artistInc![2] as { pendingBalance: number }).pendingBalance).toBeCloseTo(ulairPayout.amount as number, 2);

    // Crate seller earnings incremented by the (Stripe) payout amount.
    const crateInc = mockAtomicIncrement.mock.calls.find(c => c[0] === 'users' && c[1] === 'krotos');
    expect(crateInc).toBeDefined();
    const cratePayout = mockAddDocument.mock.calls.find(c => c[0] === 'crateSellerPayouts')![1] as Record<string, unknown>;
    expect((crateInc![2] as { crateEarnings: number }).crateEarnings).toBeCloseTo(cratePayout.amount as number, 2);

    // Merch supplier paid via a Stripe transfer in pence == supplier share.
    const supplierPayout = mockAddDocument.mock.calls.find(c => c[0] === 'supplierPayouts')![1] as Record<string, unknown>;
    const transfer = mockTransfersCreate.mock.calls.find(c => (c[0] as { metadata?: { type?: string } }).metadata?.type === 'merch_supplier')![0] as { amount: number };
    expect(transfer.amount).toBe(Math.round((supplierPayout.amount as number) * 100));
  });

  it('does NOT double-pay a consignment merch item (no brand royalty when supplierId set)', async () => {
    // A misconfigured product carrying BOTH a brandAccountId and a supplierId
    // must be paid once (supplier ~98%), never supplier + 10% royalty.
    const { processMerchRoyalties } = await import('../lib/order/paypal-capture-helpers');
    const items: Record<string, unknown>[] = [
      { id: 'prod_tee', productId: 'prod_tee', type: 'merch', name: 'Tee', price: 25, quantity: 1,
        brandAccountId: 'brand_y', brandName: 'Brand Y', supplierId: 'sup_x' },
    ];
    await processMerchRoyalties({
      orderId: 'order_dp', orderNumber: 'FW-DP-1', items,
      totalItemCount: 1, orderSubtotal: 25, stripeSecretKey: 'sk', env: {} as never,
    } as never);

    // The royalty path is gated off by the supplierId guard → no brand balance
    // increment, no royalty record.
    const brandInc = mockAtomicIncrement.mock.calls.find(c => c[0] === 'merch-suppliers' && c[1] === 'brand_y');
    expect(brandInc).toBeUndefined();
  });
});
