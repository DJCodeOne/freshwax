// src/lib/order/shipping-rules.ts
// Seller-configurable free-shipping thresholds.
//
// Merch: each supplier can enable "free shipping over £X" on their
// merch-suppliers doc (freeShippingEnabled + freeShippingThreshold). The
// order's single merch shipping charge (£4.99) is waived only when EVERY
// merch group in the basket qualifies. House merch (no supplierId) never
// auto-waives — there is no global free-over-£50 rule any more.
//
// Crates: each vinyl seller can enable the same on their seller settings
// (vinyl-sellers / D1 vinyl_sellers). When their crates subtotal in the
// basket meets the threshold, cratesShippingCost is zeroed on their items —
// which flows through to both the buyer charge and the seller payout.

import { getDocument } from '../firebase-rest';
import { d1GetVinylSeller } from '../d1-catalog';
import { log } from './types';
import type { CartItem } from './types';

type D1Db = import('@cloudflare/workers-types').D1Database;

export const MERCH_SHIPPING_FLAT = 4.99;
const DEFAULT_FREE_SHIPPING_THRESHOLD = 50;
const DEFAULT_CRATE_ADDITIONAL = 0.5; // 50p per additional record, seller-overridable

/**
 * Combined crate shipping for ONE seller's crate items (mutates in place):
 * the first record keeps its listing's single rate; every additional record
 * (extra listings + extra quantity from that seller) is charged `additional`.
 * Rewrites each item's cratesShippingCost so the existing `cratesShippingCost ×
 * qty` sum (used by both the buyer charge and the seller payout) reproduces the
 * combined total. Pure + synchronous so it's unit-testable.
 */
export function combineCrateShippingGroup(group: CartItem[], additional: number): void {
  const totalRecords = group.reduce((s, i) => s + ((i.quantity as number) || 1), 0);
  if (totalRecords <= 1) return;
  let recordsSoFar = 0;
  for (const item of group) {
    const qty = (item.quantity as number) || 1;
    const single = (item.cratesShippingCost as number) || 0;
    let itemTotal = 0;
    for (let u = 0; u < qty; u++) {
      itemTotal += recordsSoFar === 0 ? single : additional;
      recordsSoFar++;
    }
    item.cratesShippingCost = qty === 1 ? itemTotal : Math.round((itemTotal / qty) * 100) / 100;
  }
}

/**
 * Apply combined crate shipping across the basket: group crate items by seller
 * and, for sellers with >1 record, charge first-record-single + additional per
 * extra (seller's `shippingAdditional`, default 50p). Run BEFORE
 * applyCrateFreeShipping (which may then zero everything if a threshold is met).
 */
export async function applyCrateCombinedShipping(items: CartItem[], db?: D1Db): Promise<void> {
  const crateItems = items.filter(i => i.type === 'vinyl' && i.sellerId && !i.releaseId);
  if (crateItems.length === 0) return;

  const bySeller = new Map<string, CartItem[]>();
  for (const item of crateItems) {
    const sid = item.sellerId as string;
    if (!bySeller.has(sid)) bySeller.set(sid, []);
    bySeller.get(sid)!.push(item);
  }

  for (const [sellerId, group] of bySeller) {
    if (group.reduce((s, i) => s + ((i.quantity as number) || 1), 0) <= 1) continue;
    let additional = DEFAULT_CRATE_ADDITIONAL;
    try {
      let settings: Record<string, unknown> | null = db ? await d1GetVinylSeller(db, sellerId) : null;
      if (!settings || settings.shippingAdditional == null) {
        settings = await getDocument('vinyl-sellers', sellerId).catch(() => null);
      }
      const raw = settings?.shippingAdditional;
      const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
      if (Number.isFinite(n) && n >= 0) additional = n;
    } catch (e: unknown) {
      log.warn('[shipping-rules] Crate additional-rate lookup failed for', sellerId, e);
    }
    combineCrateShippingGroup(group, additional);
  }
}

function groupSubtotal(group: CartItem[]): number {
  return group.reduce((sum, i) => sum + ((i.price as number) || 0) * ((i.quantity as number) || 1), 0);
}

function resolveThreshold(value: unknown): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FREE_SHIPPING_THRESHOLD;
}

/**
 * Zero out cratesShippingCost for crate items whose seller offers free
 * shipping and whose basket subtotal meets the seller's threshold.
 * Mutates items in place; call after validateAndGetPrices.
 */
export async function applyCrateFreeShipping(items: CartItem[], db?: D1Db): Promise<void> {
  const crateItems = items.filter(i => i.type === 'vinyl' && i.sellerId && !i.releaseId);
  if (crateItems.length === 0) return;

  const bySeller = new Map<string, CartItem[]>();
  for (const item of crateItems) {
    const sid = item.sellerId as string;
    if (!bySeller.has(sid)) bySeller.set(sid, []);
    bySeller.get(sid)!.push(item);
  }

  for (const [sellerId, group] of bySeller) {
    try {
      // Free-shipping opt-in lives on the Firebase vinyl-sellers doc (the D1
      // mirror doesn't carry these flags), so read that for the waiver decision.
      const settings = await getDocument('vinyl-sellers', sellerId).catch(() => null);
      if (!settings || settings.freeShippingEnabled !== true) continue;

      const threshold = resolveThreshold(settings.freeShippingThreshold);
      if (groupSubtotal(group) >= threshold) {
        for (const item of group) item.cratesShippingCost = 0;
        log.info('[shipping-rules] Crate free shipping applied for seller', sellerId);
      }
    } catch (e: unknown) {
      log.warn('[shipping-rules] Crate free-shipping lookup failed for', sellerId, e);
    }
  }
}

/**
 * Per-artist release-vinyl shipping: the first record (per artist) charges the
 * single region rate (release → artist-account → floor), and each ADDITIONAL
 * record charges the additional-record rate (release → artist → 50p default).
 * Crate items (sellerId, no releaseId) are skipped — they're charged separately.
 * Reads both the `vinyl*`/`artistVinyl*` (Stripe/PayPal) and `serverVinyl*`/
 * `serverArtist*` (create-order) field variants so it works for all endpoints.
 * Returns the total AND the artistShippingBreakdown that feeds the artist payout.
 */
export function computeReleaseVinylShipping(
  items: CartItem[],
  region: 'UK' | 'EU' | 'INTL'
): { total: number; breakdown: Record<string, { artistId: string; artistName: string; amount: number }> } {
  const breakdown: Record<string, { artistId: string; artistName: string; amount: number }> = {};
  const round2 = (n: number) => Math.round(n * 100) / 100;
  let total = 0;

  for (const item of items) {
    if (item.type !== 'vinyl') continue;
    if (item.sellerId && !item.releaseId) continue; // crate — charged separately
    const artistId = item.artistId as string | undefined;
    if (!artistId) continue;

    let single: number;
    if (region === 'UK') single = (item.vinylShippingUK ?? item.serverVinylShippingUK ?? item.artistVinylShippingUK ?? item.serverArtistShippingUK ?? 4.99) as number;
    else if (region === 'EU') single = (item.vinylShippingEU ?? item.serverVinylShippingEU ?? item.artistVinylShippingEU ?? item.serverArtistShippingEU ?? 9.99) as number;
    else single = (item.vinylShippingIntl ?? item.serverVinylShippingIntl ?? item.artistVinylShippingIntl ?? item.serverArtistShippingIntl ?? 14.99) as number;

    const additional = (item.vinylShippingAdditional ?? item.serverVinylShippingAdditional ?? item.artistVinylShippingAdditional ?? item.serverArtistShippingAdditional ?? 0.5) as number;
    const qty = (item.quantity as number) || 1;

    let lineShip: number;
    if (!breakdown[artistId]) {
      lineShip = round2(single + additional * Math.max(0, qty - 1));
      breakdown[artistId] = { artistId, artistName: (item.artist || item.artistName || 'Artist') as string, amount: lineShip };
    } else {
      lineShip = round2(additional * qty);
      breakdown[artistId].amount = round2(breakdown[artistId].amount + lineShip);
    }
    total = round2(total + lineShip);
  }

  return { total, breakdown };
}

/**
 * Compute the order's merch shipping charge. Flat £4.99 unless every
 * supplier-attributed merch group qualifies for that supplier's free
 * shipping threshold. Items without a supplier (house merch) always charge.
 */
export async function computeMerchShipping(items: CartItem[]): Promise<number> {
  const merchItems = items.filter(i => i.type === 'merch');
  if (merchItems.length === 0) return 0;

  const bySupplier = new Map<string, CartItem[]>();
  for (const item of merchItems) {
    const key = (item.supplierId as string) || '__platform__';
    if (!bySupplier.has(key)) bySupplier.set(key, []);
    bySupplier.get(key)!.push(item);
  }

  let allWaived = true;
  for (const [supplierId, group] of bySupplier) {
    if (supplierId === '__platform__') { allWaived = false; continue; }
    try {
      const supplier = await getDocument('merch-suppliers', supplierId).catch(() => null);
      if (!supplier || supplier.freeShippingEnabled !== true) { allWaived = false; continue; }
      const threshold = resolveThreshold(supplier.freeShippingThreshold);
      if (groupSubtotal(group) < threshold) allWaived = false;
    } catch (e: unknown) {
      log.warn('[shipping-rules] Merch free-shipping lookup failed for', supplierId, e);
      allWaived = false;
    }
  }

  return allWaived ? 0 : MERCH_SHIPPING_FLAT;
}
