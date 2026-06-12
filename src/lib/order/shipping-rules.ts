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
      let settings: Record<string, unknown> | null = null;
      if (db) settings = await d1GetVinylSeller(db, sellerId);
      if (!settings) settings = await getDocument('vinyl-sellers', sellerId).catch(() => null);
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
