// src/lib/order/stock-cleanup.ts
// Cleanup expired stock reservations — called by cron endpoint

import { getDocument, getDocumentsBatch, updateDocument, updateDocumentConditional, queryCollection } from '../firebase-rest';
import { log } from './types';
import type { VariantStockEntry } from './types';

// Internal: batch-fetch all documents needed for cleanup items, grouped by collection
async function prefetchCleanupDocs(
  items: { itemType: string; productId: string }[]
): Promise<{ merchMap: Map<string, Record<string, unknown>>; releaseMap: Map<string, Record<string, unknown>>; listingMap: Map<string, Record<string, unknown>> }> {
  const merchIds = [...new Set(items.filter(r => (r.itemType || 'merch') === 'merch').map(r => r.productId))];
  const releaseIds = [...new Set(items.filter(r => r.itemType === 'vinyl-release').map(r => r.productId))];
  const listingIds = [...new Set(items.filter(r => r.itemType === 'vinyl-listing').map(r => r.productId))];

  const [merchMap, releaseMap, listingMap] = await Promise.all([
    merchIds.length > 0 ? getDocumentsBatch('merch', merchIds) : Promise.resolve(new Map<string, Record<string, unknown>>()),
    releaseIds.length > 0 ? getDocumentsBatch('releases', releaseIds) : Promise.resolve(new Map<string, Record<string, unknown>>()),
    listingIds.length > 0 ? getDocumentsBatch('vinylListings', listingIds) : Promise.resolve(new Map<string, Record<string, unknown>>()),
  ]);

  return { merchMap, releaseMap, listingMap };
}

// Cleanup expired reservations - called by cron endpoint
export async function cleanupExpiredReservations(): Promise<number> {
  const MAX_RETRIES = 3;
  let cleanedCount = 0;

  try {
    const now = new Date().toISOString();
    // throwOnError: this is an equality + range composite query, so it needs a
    // Firestore composite index on (status, expiresAt). Without one Firestore
    // returns 400 FAILED_PRECONDITION — and queryCollection's default is to
    // swallow that and return [], which made the job report a healthy
    // "cleaned: 0" on every run while reservations piled up for six months.
    // A missing index must be loud: an unswept reservation holds real stock.
    let expired: Awaited<ReturnType<typeof queryCollection>>;
    try {
      expired = await queryCollection('stock-reservations', {
        filters: [
          { field: 'status', op: 'EQUAL', value: 'active' },
          { field: 'expiresAt', op: 'LESS_THAN', value: now }
        ],
        limit: 50
      }, true);
    } catch (queryErr: unknown) {
      const msg = queryErr instanceof Error ? queryErr.message : String(queryErr);
      log.error('[cleanup] Expired-reservation query FAILED — reservations are NOT being swept:', msg);
      throw queryErr;
    }

    if (!expired || expired.length === 0) return 0;

    // Gather all items across all expired reservations for batch pre-fetch
    const allItems: { itemType: string; productId: string; variantKey: string; quantity: number }[] = [];
    for (const reservation of expired) {
      for (const res of (reservation.items || []) as { itemType: string; productId: string; variantKey: string; quantity: number }[]) {
        allItems.push(res);
      }
    }
    const { merchMap, releaseMap, listingMap } = await prefetchCleanupDocs(allItems);

    for (const reservation of expired) {
      // Decrement reserved counts per item type
      for (const res of (reservation.items || []) as { itemType: string; productId: string; variantKey: string; quantity: number }[]) {
        const itemType = res.itemType || 'merch';

        if (itemType === 'merch') {
          for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
              // Use pre-fetched data on first attempt, fresh fetch on retry
              const product = attempt === 0
                ? (merchMap.get(res.productId) || null)
                : await getDocument('merch', res.productId);
              if (!product) break;

              const variantStock = product.variantStock || {};
              const variant = (variantStock as Record<string, VariantStockEntry>)[res.variantKey];
              if (!variant) break;

              variant.reserved = Math.max(0, (variant.reserved || 0) - res.quantity);
              (variantStock as Record<string, VariantStockEntry>)[res.variantKey] = variant;

              let totalReserved = 0;
              Object.values(variantStock as Record<string, unknown>).forEach((v: unknown) => {
                if (typeof v === 'object' && v !== null) totalReserved += (v as VariantStockEntry).reserved || 0;
              });

              if (product._updateTime) {
                await updateDocumentConditional('merch', res.productId, {
                  variantStock,
                  reservedStock: totalReserved,
                  updatedAt: new Date().toISOString()
                }, product._updateTime as string);
              } else {
                await updateDocument('merch', res.productId, {
                  variantStock,
                  reservedStock: totalReserved,
                  updatedAt: new Date().toISOString()
                });
              }
              break;
            } catch (err: unknown) {
              if (err instanceof Error && err.message.includes('CONFLICT') && attempt < MAX_RETRIES - 1) continue;
              log.error('[order-utils] Cleanup: failed to release merch stock for', res.productId);
            }
          }
        } else if (itemType === 'vinyl-release') {
          for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
              // Use pre-fetched data on first attempt, fresh fetch on retry
              const release = attempt === 0
                ? (releaseMap.get(res.productId) || null)
                : await getDocument('releases', res.productId);
              if (!release) break;

              const updateData: Record<string, unknown> = {
                vinylReserved: Math.max(0, ((release.vinylReserved as number) ?? 0) - res.quantity),
                updatedAt: new Date().toISOString()
              };

              if (release._updateTime) {
                await updateDocumentConditional('releases', res.productId, updateData, release._updateTime as string);
              } else {
                await updateDocument('releases', res.productId, updateData);
              }
              break;
            } catch (err: unknown) {
              if (err instanceof Error && err.message.includes('CONFLICT') && attempt < MAX_RETRIES - 1) continue;
              log.error('[order-utils] Cleanup: failed to release vinyl stock for', res.productId);
            }
          }
        } else if (itemType === 'vinyl-listing') {
          try {
            // Use pre-fetched data
            const listing = listingMap.get(res.productId) || null;
            if (listing && listing.status === 'reserved') {
              await updateDocument('vinylListings', res.productId, {
                status: 'published',
                reservedAt: null,
                reservedBy: null,
                updatedAt: new Date().toISOString()
              });
            }
          } catch (err: unknown) {
            log.error('[order-utils] Cleanup: failed to release listing for', res.productId);
          }
        }
      }

      await updateDocument('stock-reservations', reservation.id as string, {
        status: 'expired',
        releasedAt: new Date().toISOString()
      });
      cleanedCount++;
    }
  } catch (err: unknown) {
    log.error('[order-utils] Cleanup error:', err);
  }

  return cleanedCount;
}
