// src/lib/order/stock-reservation.ts
// Stock reservation system — prevents overselling during checkout

import { getDocument, getDocumentsBatch, updateDocument, setDocument, updateDocumentConditional, queryCollection } from '../firebase-rest';
import { log, RESERVATION_TTL_MS } from './types';
import type { CartItem, VariantStockEntry } from './types';

// Internal: batch-fetch all documents needed for a set of reservation items, grouped by collection
async function prefetchReservationDocs(
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

// Internal: rollback reservations already made if a subsequent one fails
async function rollbackReservations(reserved: { itemType: string; productId: string; variantKey: string; quantity: number }[]): Promise<void> {
  const MAX_RETRIES = 3;

  // Batch pre-fetch all documents needed for rollback
  const { merchMap, releaseMap, listingMap } = await prefetchReservationDocs(reserved);

  for (const res of reserved) {
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
          log.error('[order-utils] Rollback failed for merch', res.productId, err);
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
            vinylReserved: Math.max(0, (release.vinylReserved ?? 0) - res.quantity),
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
          log.error('[order-utils] Rollback failed for vinyl release', res.productId, err);
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
        log.error('[order-utils] Rollback failed for vinyl listing', res.productId, err);
      }
    }
  }
}

// Reserve stock for checkout - prevents overselling
export async function reserveStock(
  items: CartItem[],
  sessionId: string,
  userId?: string
): Promise<{ success: boolean; reservationId?: string; expiresAt?: string; error?: string }> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RESERVATION_TTL_MS).toISOString();
  const MAX_RETRIES = 3;

  // Collect merch items for reservation
  const merchItems = items.filter(i => i.type === 'merch' && i.productId);

  // Collect vinyl release items (store vinyl with vinylStock, NOT crates listings)
  const vinylReleaseItems = items.filter(i =>
    i.type === 'vinyl' && (i.releaseId || i.productId) && !(i.sellerId && !i.releaseId)
  );

  // Collect vinyl listing items (Crates marketplace - unique items from sellers)
  const vinylListingItems = items.filter(i =>
    i.type === 'vinyl' && i.sellerId && !i.releaseId && (i.id || i.productId)
  );

  if (merchItems.length === 0 && vinylReleaseItems.length === 0 && vinylListingItems.length === 0) {
    return { success: true }; // Nothing to reserve
  }

  // Build list of reservations to make (tagged by type for release/cleanup)
  const reservations: { itemType: string; productId: string; variantKey: string; quantity: number }[] = [];

  for (const item of merchItems) {
    const size = (item.size || 'onesize').toLowerCase().replace(/\s/g, '-');
    const color = (item.color || 'default').toLowerCase().replace(/\s/g, '-');
    const variantKey = size + '_' + color;
    reservations.push({
      itemType: 'merch',
      productId: item.productId,
      variantKey,
      quantity: item.quantity || 1
    });
  }

  for (const item of vinylReleaseItems) {
    reservations.push({
      itemType: 'vinyl-release',
      productId: item.releaseId || item.productId,
      variantKey: '',
      quantity: item.quantity || 1
    });
  }

  for (const item of vinylListingItems) {
    reservations.push({
      itemType: 'vinyl-listing',
      productId: item.id || item.productId,
      variantKey: '',
      quantity: 1
    });
  }

  // Batch pre-fetch all documents needed for reservations
  const { merchMap, releaseMap, listingMap } = await prefetchReservationDocs(reservations);

  // Try to reserve each item with optimistic concurrency
  const reservedSoFar: typeof reservations = [];

  for (const res of reservations) {
    let reserved = false;

    if (res.itemType === 'merch') {
      // --- MERCH RESERVATION (variant-level) ---
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          // Use pre-fetched data on first attempt, fresh fetch on retry
          const product = attempt === 0
            ? (merchMap.get(res.productId) || null)
            : await getDocument('merch', res.productId);
          if (!product) {
            await rollbackReservations(reservedSoFar);
            return { success: false, error: `Product not found: ${res.productId}` };
          }

          const variantStock = product.variantStock || {};
          let resolvedKey = res.variantKey;
          if (!(variantStock as Record<string, unknown>)[resolvedKey]) {
            const keys = Object.keys(variantStock as Record<string, unknown>);
            const [sizePart, colorPart] = resolvedKey.split('_');
            if (keys.length === 1) {
              // Only one variant — use it regardless of key name
              resolvedKey = keys[0];
            } else if (keys.length > 1) {
              // Try size prefix match first, then color suffix, then first key
              const sizeMatch = keys.find(k => k.startsWith(sizePart + '_'));
              const colorMatch = keys.find(k => k.endsWith('_' + colorPart));
              resolvedKey = sizeMatch || colorMatch || keys[0];
            }
          }
          const variant = (variantStock as Record<string, VariantStockEntry>)[resolvedKey];
          if (!variant) {
            await rollbackReservations(reservedSoFar);
            return { success: false, error: `Variant not found: ${res.variantKey}` };
          }

          const available = (variant.stock || 0) - (variant.reserved || 0);
          if (available < res.quantity) {
            await rollbackReservations(reservedSoFar);
            return { success: false, error: `Insufficient stock for ${resolvedKey}. Available: ${available}` };
          }

          variant.reserved = (variant.reserved || 0) + res.quantity;
          (variantStock as Record<string, VariantStockEntry>)[resolvedKey] = variant;

          let totalReserved = 0;
          Object.values(variantStock as Record<string, unknown>).forEach((v: unknown) => {
            if (typeof v === 'object' && v !== null) totalReserved += (v as VariantStockEntry).reserved || 0;
          });

          const updateData: Record<string, unknown> = {
            variantStock,
            reservedStock: totalReserved,
            updatedAt: now.toISOString()
          };

          if (product._updateTime) {
            await updateDocumentConditional('merch', res.productId, updateData, product._updateTime as string);
          } else {
            await updateDocument('merch', res.productId, updateData);
          }

          reserved = true;
          reservedSoFar.push(res);
          break;
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes('CONFLICT') && attempt < MAX_RETRIES - 1) continue;
          if (attempt === MAX_RETRIES - 1) {
            await rollbackReservations(reservedSoFar);
            return { success: false, error: `Failed to reserve stock: ${errMsg}` };
          }
        }
      }
    } else if (res.itemType === 'vinyl-release') {
      // --- VINYL RELEASE RESERVATION (vinylReserved counter) ---
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          // Use pre-fetched data on first attempt, fresh fetch on retry
          const release = attempt === 0
            ? (releaseMap.get(res.productId) || null)
            : await getDocument('releases', res.productId);
          if (!release) {
            await rollbackReservations(reservedSoFar);
            return { success: false, error: `Release not found: ${res.productId}` };
          }

          const vinylStock = (release.vinylStock as number) ?? 0;
          const vinylReserved = (release.vinylReserved as number) ?? 0;
          const available = vinylStock - vinylReserved;

          if (available < res.quantity) {
            await rollbackReservations(reservedSoFar);
            return { success: false, error: `Insufficient vinyl stock. Available: ${available}` };
          }

          const updateData: Record<string, unknown> = {
            vinylReserved: vinylReserved + res.quantity,
            updatedAt: now.toISOString()
          };

          if (release._updateTime) {
            await updateDocumentConditional('releases', res.productId, updateData, release._updateTime as string);
          } else {
            await updateDocument('releases', res.productId, updateData);
          }

          reserved = true;
          reservedSoFar.push(res);
          break;
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes('CONFLICT') && attempt < MAX_RETRIES - 1) continue;
          if (attempt === MAX_RETRIES - 1) {
            await rollbackReservations(reservedSoFar);
            return { success: false, error: `Failed to reserve vinyl stock: ${errMsg}` };
          }
        }
      }
    } else if (res.itemType === 'vinyl-listing') {
      // --- VINYL LISTING RESERVATION (Crates - set status to 'reserved') ---
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          // Use pre-fetched data on first attempt, fresh fetch on retry
          const listing = attempt === 0
            ? (listingMap.get(res.productId) || null)
            : await getDocument('vinylListings', res.productId);
          if (!listing) {
            await rollbackReservations(reservedSoFar);
            return { success: false, error: `Listing not found: ${res.productId}` };
          }

          if (listing.status !== 'published') {
            await rollbackReservations(reservedSoFar);
            return { success: false, error: `Listing no longer available (status: ${listing.status})` };
          }

          const updateData: Record<string, unknown> = {
            status: 'reserved',
            reservedAt: now.toISOString(),
            reservedBy: userId || sessionId,
            updatedAt: now.toISOString()
          };

          if (listing._updateTime) {
            await updateDocumentConditional('vinylListings', res.productId, updateData, listing._updateTime as string);
          } else {
            await updateDocument('vinylListings', res.productId, updateData);
          }

          reserved = true;
          reservedSoFar.push(res);
          break;
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes('CONFLICT') && attempt < MAX_RETRIES - 1) continue;
          if (attempt === MAX_RETRIES - 1) {
            await rollbackReservations(reservedSoFar);
            return { success: false, error: `Failed to reserve listing: ${errMsg}` };
          }
        }
      }
    }

    if (!reserved) {
      await rollbackReservations(reservedSoFar);
      return { success: false, error: 'Failed to reserve stock after retries' };
    }
  }

  // Store reservation record in Firestore
  const reservationId = `res_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
  try {
    await setDocument('stock-reservations', reservationId, {
      id: reservationId,
      sessionId,
      userId: userId || null,
      items: reservations,
      status: 'active',
      createdAt: now.toISOString(),
      expiresAt
    });
  } catch (err: unknown) {
    log.error('[order-utils] Failed to store reservation record:', err);
  }

  log.info('[order-utils] Stock reserved:', reservationId, 'expires:', expiresAt);
  return { success: true, reservationId, expiresAt };
}

// Release a reservation (e.g., checkout abandoned/expired)
export async function releaseReservation(sessionOrReservationId: string): Promise<void> {
  const MAX_RETRIES = 3;

  try {
    // Find reservation by sessionId or reservationId
    let reservation: Record<string, unknown> | null = null;

    // Try direct lookup first
    reservation = await getDocument('stock-reservations', sessionOrReservationId);

    // If not found, search by sessionId
    if (!reservation) {
      const results = await queryCollection('stock-reservations', {
        filters: [
          { field: 'sessionId', op: 'EQUAL', value: sessionOrReservationId },
          { field: 'status', op: 'EQUAL', value: 'active' }
        ],
        limit: 1
      });
      if (results && results.length > 0) {
        reservation = results[0];
      }
    }

    if (!reservation || reservation.status !== 'active') {
      return; // Nothing to release
    }

    // Batch pre-fetch all documents needed for release
    const resItems = (reservation.items || []) as { itemType: string; productId: string; variantKey: string; quantity: number }[];
    const { merchMap, releaseMap, listingMap } = await prefetchReservationDocs(resItems);

    // Decrement reserved counts on each product
    for (const res of resItems) {
      const itemType = res.itemType || 'merch'; // Default to merch for backward compat

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

            const updateData: Record<string, unknown> = {
              variantStock,
              reservedStock: totalReserved,
              updatedAt: new Date().toISOString()
            };

            if (product._updateTime) {
              await updateDocumentConditional('merch', res.productId, updateData, product._updateTime as string);
            } else {
              await updateDocument('merch', res.productId, updateData);
            }
            break;
          } catch (err: unknown) {
            if (err instanceof Error && err.message.includes('CONFLICT') && attempt < MAX_RETRIES - 1) continue;
            log.error('[order-utils] Failed to release merch reservation for', res.productId, err);
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
            log.error('[order-utils] Failed to release vinyl reservation for', res.productId, err);
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
          log.error('[order-utils] Failed to release listing reservation for', res.productId, err);
        }
      }
    }

    // Mark reservation as expired/released
    await updateDocument('stock-reservations', reservation.id, {
      status: 'expired',
      releasedAt: new Date().toISOString()
    });

    log.info('[order-utils] Reservation released:', reservation.id);
  } catch (err: unknown) {
    log.error('[order-utils] Error releasing reservation:', err);
  }
}

// Convert reservation to sold (payment succeeded)
export async function convertReservation(sessionOrReservationId: string): Promise<void> {
  try {
    let reservation: Record<string, unknown> | null = null;

    reservation = await getDocument('stock-reservations', sessionOrReservationId);

    if (!reservation) {
      const results = await queryCollection('stock-reservations', {
        filters: [
          { field: 'sessionId', op: 'EQUAL', value: sessionOrReservationId },
          { field: 'status', op: 'EQUAL', value: 'active' }
        ],
        limit: 1
      });
      if (results && results.length > 0) {
        reservation = results[0];
      }
    }

    if (!reservation || reservation.status !== 'active') {
      return; // Nothing to convert
    }

    await updateDocument('stock-reservations', reservation.id, {
      status: 'converted',
      convertedAt: new Date().toISOString()
    });

    log.info('[order-utils] Reservation converted:', reservation.id);
  } catch (err: unknown) {
    log.error('[order-utils] Error converting reservation:', err);
  }
}

// Cleanup — extracted to stock-cleanup.ts, re-exported for backward compat
export { cleanupExpiredReservations } from './stock-cleanup';
