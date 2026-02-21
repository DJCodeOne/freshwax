// src/lib/order-utils.ts
// Shared order creation utilities for PayPal and Stripe payment flows

import { getDocument, updateDocument, addDocument, clearCache, setDocument, atomicIncrement, updateDocumentConditional, queryCollection } from './firebase-rest';
import { d1UpsertMerch } from './d1-catalog';
import { sendVinylOrderSellerEmail, sendVinylOrderAdminEmail } from './vinyl-order-emails';
import { escapeHtml, fetchWithTimeout, createLogger } from './api-utils';
import { SITE_URL } from './constants';
import { sendResendEmail } from './email';

const log = createLogger('[order-utils]');

// Shared type for cart/order items flowing through the system
interface CartItem {
  type?: string;
  productId?: string;
  releaseId?: string;
  id?: string;
  sellerId?: string;
  name?: string;
  title?: string;
  artist?: string;
  price?: number;
  originalPrice?: number;
  quantity?: number;
  size?: string;
  color?: string;
  trackId?: string;
  isPreOrder?: boolean;
  releaseDate?: string;
  image?: string;
  artwork?: string;
  format?: string;
  condition?: string;
  artistId?: string;
  artistName?: string;
  sellerName?: string;
  sellerEmail?: string;
  stockistEmail?: string;
  artistEmail?: string;
  discountPercent?: number;
  shippingCost?: number;
  cratesShippingCost?: number;
  isCratesItem?: boolean;
  vinylShippingUK?: number;
  vinylShippingEU?: number;
  vinylShippingIntl?: number;
  artistVinylShippingUK?: number;
  artistVinylShippingEU?: number;
  artistVinylShippingIntl?: number;
  downloads?: Record<string, unknown>;
  [key: string]: unknown;
}

// Variant stock entry shape
interface VariantStockEntry {
  stock?: number;
  reserved?: number;
  sold?: number;
  sku?: string;
  [key: string]: unknown;
}

// Generate order number
export function generateOrderNumber(): string {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `FW-${year}${month}${day}-${random}`;
}

// Get short order number for display (e.g., "FW-ABC123" from "FW-241204-abc123")
export function getShortOrderNumber(orderNumber: string): string {
  const orderParts = orderNumber.split('-');
  return orderParts.length >= 3
    ? (orderParts[0] + '-' + orderParts[orderParts.length - 1]).toUpperCase()
    : orderNumber.toUpperCase();
}

// =============================================
// STOCK RESERVATION SYSTEM
// =============================================

const RESERVATION_TTL_MS = 15 * 60 * 1000; // 15 minutes

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

  // Try to reserve each item with optimistic concurrency
  const reservedSoFar: typeof reservations = [];

  for (const res of reservations) {
    let reserved = false;

    if (res.itemType === 'merch') {
      // --- MERCH RESERVATION (variant-level) ---
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const product = await getDocument('merch', res.productId);
          if (!product) {
            await rollbackReservations(reservedSoFar);
            return { success: false, error: `Product not found: ${res.productId}` };
          }

          const variantStock = product.variantStock || {};
          const variant = variantStock[res.variantKey];
          if (!variant) {
            await rollbackReservations(reservedSoFar);
            return { success: false, error: `Variant not found: ${res.variantKey}` };
          }

          const available = (variant.stock || 0) - (variant.reserved || 0);
          if (available < res.quantity) {
            await rollbackReservations(reservedSoFar);
            return { success: false, error: `Insufficient stock for ${res.variantKey}. Available: ${available}` };
          }

          variant.reserved = (variant.reserved || 0) + res.quantity;
          variantStock[res.variantKey] = variant;

          let totalReserved = 0;
          Object.values(variantStock).forEach((v: unknown) => {
            if (typeof v === 'object' && v !== null) totalReserved += (v as VariantStockEntry).reserved || 0;
          });

          const updateData: Record<string, unknown> = {
            variantStock,
            reservedStock: totalReserved,
            updatedAt: now.toISOString()
          };

          if (product._updateTime) {
            await updateDocumentConditional('merch', res.productId, updateData, product._updateTime);
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
          const release = await getDocument('releases', res.productId);
          if (!release) {
            await rollbackReservations(reservedSoFar);
            return { success: false, error: `Release not found: ${res.productId}` };
          }

          const vinylStock = release.vinylStock ?? 0;
          const vinylReserved = release.vinylReserved ?? 0;
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
            await updateDocumentConditional('releases', res.productId, updateData, release._updateTime);
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
          const listing = await getDocument('vinylListings', res.productId);
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
            await updateDocumentConditional('vinylListings', res.productId, updateData, listing._updateTime);
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

    // Decrement reserved counts on each product
    for (const res of reservation.items || []) {
      const itemType = res.itemType || 'merch'; // Default to merch for backward compat

      if (itemType === 'merch') {
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            const product = await getDocument('merch', res.productId);
            if (!product) break;

            const variantStock = product.variantStock || {};
            const variant = variantStock[res.variantKey];
            if (!variant) break;

            variant.reserved = Math.max(0, (variant.reserved || 0) - res.quantity);
            variantStock[res.variantKey] = variant;

            let totalReserved = 0;
            Object.values(variantStock).forEach((v: unknown) => {
              if (typeof v === 'object' && v !== null) totalReserved += (v as VariantStockEntry).reserved || 0;
            });

            const updateData: Record<string, unknown> = {
              variantStock,
              reservedStock: totalReserved,
              updatedAt: new Date().toISOString()
            };

            if (product._updateTime) {
              await updateDocumentConditional('merch', res.productId, updateData, product._updateTime);
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
            const release = await getDocument('releases', res.productId);
            if (!release) break;

            const updateData: Record<string, unknown> = {
              vinylReserved: Math.max(0, (release.vinylReserved ?? 0) - res.quantity),
              updatedAt: new Date().toISOString()
            };

            if (release._updateTime) {
              await updateDocumentConditional('releases', res.productId, updateData, release._updateTime);
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
          const listing = await getDocument('vinylListings', res.productId);
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

// Cleanup expired reservations - called by cron endpoint
export async function cleanupExpiredReservations(): Promise<number> {
  const MAX_RETRIES = 3;
  let cleanedCount = 0;

  try {
    const now = new Date().toISOString();
    const expired = await queryCollection('stock-reservations', {
      filters: [
        { field: 'status', op: 'EQUAL', value: 'active' },
        { field: 'expiresAt', op: 'LESS_THAN', value: now }
      ],
      limit: 50
    });

    if (!expired || expired.length === 0) return 0;

    for (const reservation of expired) {
      // Decrement reserved counts per item type
      for (const res of reservation.items || []) {
        const itemType = res.itemType || 'merch';

        if (itemType === 'merch') {
          for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
              const product = await getDocument('merch', res.productId);
              if (!product) break;

              const variantStock = product.variantStock || {};
              const variant = variantStock[res.variantKey];
              if (!variant) break;

              variant.reserved = Math.max(0, (variant.reserved || 0) - res.quantity);
              variantStock[res.variantKey] = variant;

              let totalReserved = 0;
              Object.values(variantStock).forEach((v: unknown) => {
                if (typeof v === 'object' && v !== null) totalReserved += (v as VariantStockEntry).reserved || 0;
              });

              if (product._updateTime) {
                await updateDocumentConditional('merch', res.productId, {
                  variantStock,
                  reservedStock: totalReserved,
                  updatedAt: new Date().toISOString()
                }, product._updateTime);
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
              const release = await getDocument('releases', res.productId);
              if (!release) break;

              const updateData: Record<string, unknown> = {
                vinylReserved: Math.max(0, (release.vinylReserved ?? 0) - res.quantity),
                updatedAt: new Date().toISOString()
              };

              if (release._updateTime) {
                await updateDocumentConditional('releases', res.productId, updateData, release._updateTime);
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
            const listing = await getDocument('vinylListings', res.productId);
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

      await updateDocument('stock-reservations', reservation.id, {
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

// Internal: rollback reservations already made if a subsequent one fails
async function rollbackReservations(reserved: { itemType: string; productId: string; variantKey: string; quantity: number }[]): Promise<void> {
  const MAX_RETRIES = 3;
  for (const res of reserved) {
    const itemType = res.itemType || 'merch';

    if (itemType === 'merch') {
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const product = await getDocument('merch', res.productId);
          if (!product) break;

          const variantStock = product.variantStock || {};
          const variant = variantStock[res.variantKey];
          if (!variant) break;

          variant.reserved = Math.max(0, (variant.reserved || 0) - res.quantity);
          variantStock[res.variantKey] = variant;

          let totalReserved = 0;
          Object.values(variantStock).forEach((v: unknown) => {
            if (typeof v === 'object' && v !== null) totalReserved += (v as VariantStockEntry).reserved || 0;
          });

          if (product._updateTime) {
            await updateDocumentConditional('merch', res.productId, {
              variantStock,
              reservedStock: totalReserved,
              updatedAt: new Date().toISOString()
            }, product._updateTime);
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
          const release = await getDocument('releases', res.productId);
          if (!release) break;

          const updateData: Record<string, unknown> = {
            vinylReserved: Math.max(0, (release.vinylReserved ?? 0) - res.quantity),
            updatedAt: new Date().toISOString()
          };

          if (release._updateTime) {
            await updateDocumentConditional('releases', res.productId, updateData, release._updateTime);
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
        const listing = await getDocument('vinylListings', res.productId);
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

// Validate stock availability before checkout
export async function validateStock(items: CartItem[]): Promise<{ available: boolean, unavailableItems: string[] }> {
  const unavailableItems: string[] = [];

  // Pre-fetch all needed documents in parallel to avoid N+1 sequential calls
  // Use throwOnError=true so callers know if Firebase is unreachable vs "item not found"
  const merchIds = [...new Set(items.filter(i => (i.type || 'digital') === 'merch' && i.productId).map(i => i.productId))];
  const releaseIds = [...new Set(items.filter(i => (i.type || 'digital') === 'vinyl' && !(i.sellerId && !i.releaseId) && (i.releaseId || i.productId || i.id)).map(i => i.releaseId || i.productId || i.id))];
  const listingIds = [...new Set(items.filter(i => (i.type || 'digital') === 'vinyl' && i.sellerId && !i.releaseId).map(i => i.id || i.productId).filter(Boolean))];

  const [merchDocs, releaseDocs, listingDocs] = await Promise.all([
    Promise.all(merchIds.map(id => getDocument('merch', id, undefined, true))),
    Promise.all(releaseIds.map(id => getDocument('releases', id, undefined, true))),
    Promise.all(listingIds.map(id => getDocument('vinylListings', id, undefined, true)))
  ]);

  const merchMap = new Map(merchIds.map((id, i) => [id, merchDocs[i]]));
  const releaseMap = new Map(releaseIds.map((id, i) => [id, releaseDocs[i]]));
  const listingMap = new Map(listingIds.map((id, i) => [id, listingDocs[i]]));

  for (const item of items) {
    const quantity = item.quantity || 1;
    const itemType = item.type || 'digital';

    if (itemType === 'merch' && item.productId) {
      const product = merchMap.get(item.productId);
      if (product) {
        if (item.size || item.color) {
          const size = (item.size || 'onesize').toLowerCase().replace(/\s/g, '-');
          const color = (item.color || 'default').toLowerCase().replace(/\s/g, '-');
          const variantKey = size + '_' + color;
          const variant = product.variantStock?.[variantKey];
          const variantStockAvailable = (variant?.stock ?? product.stock ?? 0) - (variant?.reserved ?? 0);
          if (variantStockAvailable < quantity) {
            unavailableItems.push(`${item.name} (${item.size || ''} ${item.color || ''}) - only ${variantStockAvailable} available`);
          }
        } else {
          const totalAvailable = (product.totalStock ?? product.stock ?? 0) - (product.reservedStock ?? 0);
          if (totalAvailable < quantity) {
            unavailableItems.push(`${item.name} - only ${totalAvailable} available`);
          }
        }
      }
    } else if (itemType === 'vinyl') {
      if (item.sellerId && !item.releaseId) {
        const listingId = item.id || item.productId;
        if (listingId) {
          const listing = listingMap.get(listingId);
          if (!listing) {
            unavailableItems.push(`${item.name} - listing no longer exists`);
          } else if (listing.status === 'sold') {
            unavailableItems.push(`${item.name} - already sold`);
          } else if (listing.status === 'reserved') {
            unavailableItems.push(`${item.name} - currently reserved by another buyer`);
          } else if (listing.status !== 'published') {
            unavailableItems.push(`${item.name} - no longer available`);
          }
        }
      } else {
        const releaseId = item.releaseId || item.productId || item.id;
        if (releaseId) {
          const release = releaseMap.get(releaseId);
          if (release) {
            const vinylStock = release.vinylStock ?? 0;
            const vinylReserved = release.vinylReserved ?? 0;
            const available = vinylStock - vinylReserved;
            if (available < quantity) {
              unavailableItems.push(`${item.name} (Vinyl) - only ${available} available`);
            }
          }
        }
      }
    }
    // Digital items have unlimited stock - no check needed
  }

  return { available: unavailableItems.length === 0, unavailableItems };
}

// Validate item prices server-side to prevent manipulation
// Shared by Stripe and PayPal checkout flows
export async function validateAndGetPrices(
  items: CartItem[],
  options: { logPrefix?: string } = {}
): Promise<{ validatedItems: CartItem[], hasPriceMismatch: boolean, validationError?: string }> {
  const prefix = options.logPrefix || '[Checkout]';
  const validatedItems: CartItem[] = [];
  let hasPriceMismatch = false;

  // Pre-fetch all needed documents in parallel to avoid N+1 sequential calls
  const merchIds = [...new Set(items.filter(i => (i.type || 'digital') === 'merch' && i.productId).map(i => i.productId))];
  const releaseIds = [...new Set(items.filter(i => {
    const t = i.type || 'digital';
    if (t === 'vinyl' && i.sellerId && !i.releaseId) return false;
    return ['vinyl', 'digital', 'track', 'release'].includes(t) && (i.releaseId || i.productId || i.id);
  }).map(i => i.releaseId || i.productId || i.id))];
  const listingIds = [...new Set(items.filter(i => (i.type || 'digital') === 'vinyl' && i.sellerId && !i.releaseId).map(i => i.id || i.productId).filter(Boolean))];

  const [merchDocs, releaseDocs, listingDocs] = await Promise.all([
    Promise.all(merchIds.map(id => getDocument('merch', id))),
    Promise.all(releaseIds.map(id => getDocument('releases', id))),
    Promise.all(listingIds.map(id => getDocument('vinylListings', id)))
  ]);

  const merchMap = new Map(merchIds.map((id, i) => [id, merchDocs[i]]));
  const releaseMap = new Map(releaseIds.map((id, i) => [id, releaseDocs[i]]));
  const listingMap = new Map(listingIds.map((id, i) => [id, listingDocs[i]]));

  // Pre-fetch artist docs for vinyl items needing shipping defaults
  const artistIdsNeeded: string[] = [];
  for (const item of items) {
    const itemType = item.type || 'digital';
    if (itemType === 'vinyl' && !(item.sellerId && !item.releaseId)) {
      const releaseId = item.releaseId || item.productId || item.id;
      if (releaseId) {
        const release = releaseMap.get(releaseId);
        const artistId = release?.artistId || release?.userId || item.artistId;
        if (artistId) artistIdsNeeded.push(artistId);
      }
    }
  }
  const uniqueArtistIds = [...new Set(artistIdsNeeded)];
  const artistDocs = await Promise.all(uniqueArtistIds.map(id => getDocument('artists', id)));
  const artistMap = new Map(uniqueArtistIds.map((id, i) => [id, artistDocs[i]]));

  for (const item of items) {
    let serverPrice = item.price;
    const itemType = item.type || 'digital';

    try {
      if (itemType === 'merch' && item.productId) {
        const product = merchMap.get(item.productId);
        if (product) {
          serverPrice = product.salePrice || product.retailPrice || product.price || item.price;
        }
      } else if (itemType === 'vinyl' || itemType === 'digital' || itemType === 'track' || itemType === 'release') {
        if (itemType === 'vinyl' && item.sellerId && !item.releaseId) {
          const listingId = item.id || item.productId;
          if (listingId) {
            const listing = listingMap.get(listingId);
            if (listing) {
              serverPrice = listing.price || item.price;
              item.cratesShippingCost = listing.shippingCost || 0;
              item.isCratesItem = true;
            }
          }
        } else {
          const releaseId = item.releaseId || item.productId || item.id;
          if (releaseId) {
            const release = releaseMap.get(releaseId);
            if (release) {
              if (itemType === 'vinyl') {
                serverPrice = release.vinylPrice || release.price || item.price;

                item.vinylShippingUK = release.vinylShippingUK;
                item.vinylShippingEU = release.vinylShippingEU;
                item.vinylShippingIntl = release.vinylShippingIntl;

                const artistId = release.artistId || release.userId || item.artistId;
                if (artistId) {
                  item.artistId = artistId;
                  const artist = artistMap.get(artistId);
                  if (artist) {
                    item.artistVinylShippingUK = artist.vinylShippingUK;
                    item.artistVinylShippingEU = artist.vinylShippingEU;
                    item.artistVinylShippingIntl = artist.vinylShippingIntl;
                    item.artistName = artist.artistName || artist.name;
                  }
                }
              } else if (itemType === 'track' && item.trackId) {
                const track = (release.tracks || []).find((t: Record<string, unknown>) =>
                  t.id === item.trackId || t.trackId === item.trackId
                );
                serverPrice = track?.price || release.trackPrice || 0.99;
              } else {
                serverPrice = release.price || release.digitalPrice || item.price;
              }
            }
          }
        }
      }

      if (Math.abs(serverPrice - item.price) > 0.01) {
        log.warn(prefix, 'Price mismatch for', item.name, '- Client:', item.price, 'Server:', serverPrice);
        hasPriceMismatch = true;
      }

      validatedItems.push({
        ...item,
        price: serverPrice,
        originalClientPrice: item.price
      });
    } catch (err: unknown) {
      log.error(prefix, 'Error validating price for', item.name, err);
      return { validatedItems: [], hasPriceMismatch: true, validationError: `Price validation failed for ${item.name}. Please try again.` };
    }
  }

  return { validatedItems, hasPriceMismatch };
}

// Process cart items to add download URLs
export async function processItemsWithDownloads(items: CartItem[]): Promise<CartItem[]> {
  return Promise.all(items.map(async (item: CartItem) => {
    const releaseId = item.releaseId || item.productId || item.id;

    log.info('[order-utils] Processing item:', item.name, 'type:', item.type, 'releaseId:', releaseId);

    // Check if this is a digital release, track, or vinyl
    if (item.type === 'digital' || item.type === 'release' || item.type === 'track' || item.type === 'vinyl' || (!item.type && releaseId)) {
      try {
        log.info('[order-utils] Fetching release from Firebase:', releaseId);
        const releaseData = await getDocument('releases', releaseId);

        if (releaseData) {
          log.info('[order-utils] Release found:', releaseData?.releaseName);

          // If it's a single track purchase, only include that track
          if (item.type === 'track') {
            let track = null;

            // Method 1: Match by trackId
            if (item.trackId) {
              track = (releaseData?.tracks || []).find((t: Record<string, unknown>) =>
                t.id === item.trackId ||
                t.trackId === item.trackId ||
                String(t.trackNumber) === String(item.trackId)
              );
            }

            // Method 2: Match by track name from item name
            if (!track && item.name) {
              const itemNameParts = item.name.split(' - ');
              const trackNameFromItem = itemNameParts.length > 1 ? itemNameParts.slice(1).join(' - ') : item.name;
              track = (releaseData?.tracks || []).find((t: Record<string, unknown>) =>
                (t.trackName || t.name || '').toLowerCase() === trackNameFromItem.toLowerCase()
              );
            }

            // Method 3: Match by title field
            if (!track && item.title) {
              track = (releaseData?.tracks || []).find((t: Record<string, unknown>) =>
                (t.trackName || t.name || '').toLowerCase() === item.title.toLowerCase()
              );
            }

            const artistName = releaseData?.artistName || item.artist || 'Unknown Artist';
            const releaseName = releaseData?.releaseName || releaseData?.title || item.title || 'Release';
            const artworkUrl = releaseData?.coverArtUrl || releaseData?.artwork?.cover || releaseData?.artwork?.artworkUrl || item.artwork || item.image || null;

            if (track) {
              return {
                ...item,
                releaseId,
                artwork: artworkUrl,
                image: artworkUrl,
                downloads: {
                  artistName,
                  releaseName,
                  artworkUrl,
                  tracks: [{
                    name: track.trackName || track.name || item.title,
                    mp3Url: track.mp3Url || null,
                    wavUrl: track.wavUrl || null
                  }]
                }
              };
            } else {
              // Fallback: include all tracks if we can't find the specific one
              return {
                ...item,
                releaseId,
                artwork: artworkUrl,
                image: artworkUrl,
                downloads: {
                  artistName,
                  releaseName,
                  artworkUrl,
                  tracks: (releaseData?.tracks || []).map((t: Record<string, unknown>) => ({
                    name: t.trackName || t.name,
                    mp3Url: t.mp3Url || null,
                    wavUrl: t.wavUrl || null
                  }))
                }
              };
            }
          }

          // Full release - include all tracks
          const artistName = releaseData?.artistName || item.artist || 'Unknown Artist';
          const releaseName = releaseData?.releaseName || releaseData?.title || item.title || 'Release';
          const artworkUrl = releaseData?.coverArtUrl || releaseData?.artwork?.cover || releaseData?.artwork?.artworkUrl || item.artwork || item.image || null;

          const downloads = {
            artistName,
            releaseName,
            artworkUrl,
            tracks: (releaseData?.tracks || []).map((track: Record<string, unknown>) => ({
              name: track.trackName || track.name,
              mp3Url: track.mp3Url || null,
              wavUrl: track.wavUrl || null
            }))
          };

          return {
            ...item,
            releaseId,
            artwork: artworkUrl,
            image: artworkUrl,
            downloads
          };
        }
      } catch (e: unknown) {
        log.error('[order-utils] Error fetching release:', releaseId, e);
      }
    }
    return { ...item, releaseId };
  }));
}

// Update stock for vinyl items (atomic)
export async function updateVinylStock(items: CartItem[], orderNumber: string, orderId: string, idToken?: string): Promise<void> {
  const now = new Date().toISOString();

  for (const item of items) {
    if (item.type === 'vinyl' && (item.releaseId || item.productId)) {
      // Skip crates items (handled by processVinylCratesOrders)
      if (item.sellerId && !item.releaseId) continue;

      const releaseId = item.releaseId || item.productId;
      try {
        const qty = item.quantity || 1;
        log.info('[order-utils] Updating vinyl stock for:', item.name, 'qty:', qty);

        // Atomic decrement stock and reserved - prevents race conditions on concurrent purchases
        const incrementFields: Record<string, number> = {
          vinylStock: -qty,
          vinylSold: qty
        };

        // Also clear the reservation counter if it was reserved
        const preCheck = await getDocument('releases', releaseId);
        if (preCheck && (preCheck.vinylReserved ?? 0) > 0) {
          incrementFields.vinylReserved = -Math.min(qty, preCheck.vinylReserved);
        }

        await atomicIncrement('releases', releaseId, incrementFields);

        // Read AFTER atomic increment to get the actual current stock
        const releaseData = await getDocument('releases', releaseId);
        const currentStock = releaseData?.vinylStock || 0;
        const previousStock = currentStock + qty; // Derive previous from current since we just decremented by qty
        const newStock = currentStock;

        // Sync vinylRecordCount (string field used by frontend display)
        await updateDocument('releases', releaseId, {
          vinylRecordCount: String(Math.max(0, newStock)),
          updatedAt: now
        });

        // Record stock movement
        await addDocument('vinyl-stock-movements', {
          releaseId: releaseId,
          releaseName: item.name || releaseData?.releaseName,
          type: 'sell',
          quantity: qty,
          stockDelta: -qty,
          previousStock: previousStock,
          newStock: newStock,
          orderId: orderId,
          orderNumber: orderNumber,
          notes: 'Order ' + orderNumber,
          createdAt: now,
          createdBy: 'system'
        }, idToken);

        log.info('[order-utils] ✓ Vinyl stock updated atomically:', item.name, previousStock, '->', newStock);
      } catch (stockErr: unknown) {
        log.error('[order-utils] Vinyl stock update error:', stockErr);
      }
    }
  }
}

// Process vinyl crates orders (marketplace items from sellers)
// Creates order records for sellers, marks listings as sold, and sends notifications
export async function processVinylCratesOrders(
  items: CartItem[],
  orderNumber: string,
  orderId: string,
  customer: { email: string; firstName: string; lastName: string },
  shipping: Record<string, unknown> | null,
  env?: Record<string, unknown>,
  idToken?: string
): Promise<void> {
  const now = new Date().toISOString();

  // Filter for crates items (have sellerId - these are marketplace items, not new releases)
  const cratesItems = items.filter(item =>
    item.type === 'vinyl' && item.sellerId && !item.releaseId
  );

  if (cratesItems.length === 0) {
    log.info('[order-utils] No vinyl crates items to process');
    return;
  }

  log.info('[order-utils] Processing', cratesItems.length, 'vinyl crates items');

  for (const item of cratesItems) {
    try {
      const listingId = item.id;
      const sellerId = item.sellerId;
      const sellerName = item.sellerName || 'Unknown Seller';

      log.info('[order-utils] Processing crates item:', item.title, 'from seller:', sellerName);

      // 1. Mark the listing as sold (with optimistic concurrency to prevent double-sell)
      // Accept both 'published' and 'reserved' status (reserved = in active checkout)
      try {
        const listing = await getDocument('vinylListings', listingId);
        const canSell = listing && (listing.status === 'published' || listing.status === 'reserved');
        if (canSell && listing._updateTime) {
          await updateDocumentConditional('vinylListings', listingId, {
            status: 'sold',
            soldAt: now,
            soldOrderNumber: orderNumber,
            soldOrderId: orderId,
            soldTo: customer.email,
            reservedAt: null,
            reservedBy: null,
            updatedAt: now
          }, listing._updateTime);
        } else if (listing && listing.status !== 'sold' && !listing._updateTime) {
          log.error('[order-utils] CRITICAL: Listing missing _updateTime, cannot guarantee concurrency protection:', listingId);
          const freshListing = await getDocument('vinylListings', listingId);
          const freshCanSell = freshListing && (freshListing.status === 'published' || freshListing.status === 'reserved');
          if (freshCanSell && freshListing._updateTime) {
            await updateDocumentConditional('vinylListings', listingId, {
              status: 'sold',
              soldAt: now,
              soldOrderNumber: orderNumber,
              soldOrderId: orderId,
              soldTo: customer.email,
              reservedAt: null,
              reservedBy: null,
              updatedAt: now
            }, freshListing._updateTime);
          } else if (freshCanSell) {
            log.error('[order-utils] WARNING: Listing missing _updateTime, using non-conditional update for:', listingId);
            await updateDocument('vinylListings', listingId, {
              status: 'sold',
              soldAt: now,
              soldOrderNumber: orderNumber,
              soldOrderId: orderId,
              soldTo: customer.email,
              reservedAt: null,
              reservedBy: null,
              updatedAt: now
            });
          }
        } else {
          log.error('[order-utils] Listing already sold or missing:', listingId);
        }
        log.info('[order-utils] ✓ Listing marked as sold:', listingId);
      } catch (markSoldErr: unknown) {
        if (markSoldErr instanceof Error && markSoldErr.message.includes('CONFLICT')) {
          log.error('[order-utils] Listing was modified concurrently (possible double-sell prevented):', listingId);
        } else {
          log.error('[order-utils] Failed to mark listing as sold:', markSoldErr);
        }
      }

      // 2. Create vinyl order record for the seller
      const vinylOrder = {
        orderId: orderId,
        orderNumber: orderNumber,
        listingId: listingId,
        sellerId: sellerId,
        sellerName: sellerName,
        title: item.title || item.name,
        artist: item.artist,
        price: item.price,
        originalPrice: item.originalPrice || item.price,
        discountPercent: item.discountPercent || 0,
        shippingCost: item.shippingCost || 0,
        format: item.format,
        condition: item.condition,
        image: item.image,
        buyer: {
          email: customer.email,
          firstName: customer.firstName,
          lastName: customer.lastName,
          name: `${customer.firstName} ${customer.lastName}`
        },
        shipping: shipping,
        status: 'pending', // Seller needs to ship
        createdAt: now,
        updatedAt: now
      };

      try {
        const vinylOrderId = `vo_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
        await setDocument('vinylOrders', vinylOrderId, vinylOrder);
        log.info('[order-utils] ✓ Vinyl order created:', vinylOrderId);
      } catch (orderErr: unknown) {
        log.error('[order-utils] Failed to create vinyl order:', orderErr);
      }

      // 3. Get seller email and send notifications
      let sellerEmail = '';
      try {
        // Try to get seller email from vinylSellers collection (or vinyl-sellers for legacy)
        let seller = await getDocument('vinylSellers', sellerId);
        if (!seller) {
          seller = await getDocument('vinyl-sellers', sellerId);
        }
        if (seller) {
          sellerEmail = seller?.email || '';
        }
        // Also try users collection
        if (!sellerEmail) {
          const user = await getDocument('users', sellerId);
          sellerEmail = user?.email || '';
        }
      } catch (e: unknown) {
        log.info('[order-utils] Could not fetch seller email');
      }

      // Send seller notification
      if (sellerEmail) {
        try {
          await sendVinylOrderSellerEmail(
            sellerEmail,
            sellerName,
            {
              orderNumber,
              itemTitle: item.title || item.name,
              itemArtist: item.artist,
              price: item.price,
              buyerName: `${customer.firstName} ${customer.lastName}`,
              buyerEmail: customer.email,
              shippingAddress: shipping
            },
            env
          );
          log.info('[order-utils] ✓ Seller email sent to:', sellerEmail);
        } catch (emailErr: unknown) {
          log.error('[order-utils] Seller email failed:', emailErr);
        }
      }

      // Send admin notification
      try {
        await sendVinylOrderAdminEmail(
          {
            orderNumber,
            sellerId,
            sellerName,
            sellerEmail: sellerEmail || 'unknown',
            itemTitle: item.title || item.name,
            itemArtist: item.artist,
            price: item.price,
            buyerName: `${customer.firstName} ${customer.lastName}`,
            buyerEmail: customer.email
          },
          env
        );
        log.info('[order-utils] ✓ Admin email sent');
      } catch (adminEmailErr: unknown) {
        log.error('[order-utils] Admin email failed:', adminEmailErr);
      }

    } catch (err: unknown) {
      log.error('[order-utils] Error processing crates item:', err);
    }
  }
}

// Refund stock when order is cancelled
export async function refundOrderStock(orderId: string, items: CartItem[], orderNumber: string, idToken?: string, env?: Record<string, unknown>): Promise<{ failedRefunds: Array<{ item: string; type: string; error: string }> }> {
  const now = new Date().toISOString();
  const failedRefunds: Array<{ item: string; type: string; error: string }> = [];

  for (const item of items) {
    // Refund merch stock
    if (item.type === 'merch' && item.productId) {
      try {
        log.info('[order-utils] Refunding merch stock for:', item.name, 'qty:', item.quantity);

        const productData = await getDocument('merch', item.productId);

        if (productData) {
          const variantStock = productData.variantStock || {};
          const size = (item.size || 'onesize').toLowerCase().replace(/\s/g, '-');
          const color = (item.color || 'default').toLowerCase().replace(/\s/g, '-');
          const variantKey = size + '_' + color;

          // Exact match only - no heuristic guessing to avoid refunding wrong variant
          if (!variantStock[variantKey]) {
            log.error('[order-utils] Refund: variant key not found:', variantKey, 'for item:', item.name, 'available keys:', Object.keys(variantStock));
          }

          const variant = variantStock[variantKey];

          if (variant) {
            const previousStock = variant.stock || 0;
            const newStock = previousStock + (item.quantity || 1);

            variant.stock = newStock;
            variant.sold = Math.max(0, (variant.sold || 0) - (item.quantity || 1));
            variantStock[variantKey] = variant;

            let totalStock = 0;
            let totalSold = 0;
            Object.values(variantStock).forEach((v: unknown) => {
              const variant = v as VariantStockEntry;
              totalStock += variant.stock || 0;
              totalSold += variant.sold || 0;
            });

            // Use conditional update if available for concurrency safety
            if (productData._updateTime) {
              await updateDocumentConditional('merch', item.productId, {
                variantStock: variantStock,
                totalStock: totalStock,
                soldStock: totalSold,
                isLowStock: totalStock <= (productData.lowStockThreshold || 5) && totalStock > 0,
                isOutOfStock: totalStock === 0,
                updatedAt: now
              }, productData._updateTime);
            } else {
              await updateDocument('merch', item.productId, {
                variantStock: variantStock,
                totalStock: totalStock,
                soldStock: totalSold,
                isLowStock: totalStock <= (productData.lowStockThreshold || 5) && totalStock > 0,
                isOutOfStock: totalStock === 0,
                updatedAt: now
              });
            }

            // Record refund movement
            await addDocument('merch-stock-movements', {
              productId: item.productId,
              productName: item.name,
              sku: productData.sku,
              variantKey: variantKey,
              variantSku: variant.sku,
              type: 'return',
              quantity: item.quantity || 1,
              stockDelta: item.quantity || 1,
              previousStock: previousStock,
              newStock: newStock,
              orderId: orderId,
              orderNumber: orderNumber,
              notes: 'Order cancelled - ' + orderNumber,
              createdAt: now,
              createdBy: 'system'
            }, idToken);

            log.info('[order-utils] ✓ Merch stock refunded:', item.name, previousStock, '->', newStock);

            // Sync to D1
            const db = env?.DB;
            if (db) {
              try {
                clearCache(`doc:merch:${item.productId}`);
                const updatedProduct = await getDocument('merch', item.productId);
                if (updatedProduct) {
                  await d1UpsertMerch(db, item.productId, updatedProduct);
                  log.info('[order-utils] ✓ D1 synced after refund:', item.name);
                }
              } catch (d1Error: unknown) {
                log.error('[order-utils] D1 sync failed (non-critical):', d1Error);
              }
            }
          }
        }
      } catch (refundErr: unknown) {
        log.error('[order-utils] Merch refund error:', refundErr);
        failedRefunds.push({ item: item.name || item.productId, type: 'merch', error: refundErr instanceof Error ? refundErr.message : String(refundErr) });
      }
    }

    // Refund vinyl stock
    if (item.type === 'vinyl' && (item.releaseId || item.productId)) {
      const releaseId = item.releaseId || item.productId;
      try {
        log.info('[order-utils] Refunding vinyl stock for:', item.name, 'qty:', item.quantity);

        const releaseData = await getDocument('releases', releaseId);

        if (releaseData) {
          const previousStock = releaseData.vinylStock || 0;
          const qty = item.quantity || 1;
          const newStock = previousStock + qty;

          // Atomic increment for stock restoration
          await atomicIncrement('releases', releaseId, {
            vinylStock: qty,
            vinylSold: -qty
          });

          // Sync vinylRecordCount display field
          await updateDocument('releases', releaseId, {
            vinylRecordCount: String(newStock),
            updatedAt: now
          });

          await addDocument('vinyl-stock-movements', {
            releaseId: releaseId,
            releaseName: item.name || releaseData.releaseName,
            type: 'return',
            quantity: item.quantity || 1,
            stockDelta: item.quantity || 1,
            previousStock: previousStock,
            newStock: newStock,
            orderId: orderId,
            orderNumber: orderNumber,
            notes: 'Order cancelled - ' + orderNumber,
            createdAt: now,
            createdBy: 'system'
          }, idToken);

          log.info('[order-utils] ✓ Vinyl stock refunded:', item.name, previousStock, '->', newStock);
        }
      } catch (refundErr: unknown) {
        log.error('[order-utils] Vinyl refund error:', refundErr);
        failedRefunds.push({ item: item.name || releaseId, type: 'vinyl', error: refundErr instanceof Error ? refundErr.message : String(refundErr) });
      }
    }

    // Restore vinyl crates listings
    if (item.type === 'vinyl' && item.sellerId && !item.releaseId) {
      const listingId = item.id || item.productId;
      if (listingId) {
        try {
          await updateDocument('vinylListings', listingId, {
            status: 'published',
            soldAt: null,
            soldOrderNumber: null,
            soldOrderId: null,
            soldTo: null,
            updatedAt: now
          });
          log.info('[order-utils] ✓ Vinyl crates listing restored:', listingId);
        } catch (restoreErr: unknown) {
          log.error('[order-utils] Failed to restore vinyl crates listing:', restoreErr);
          failedRefunds.push({ item: item.name || listingId, type: 'vinyl-crates', error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr) });
        }
      }
    }
  }

  // Report any failed refunds
  if (failedRefunds.length > 0) {
    log.error('[order-utils] CRITICAL: Failed to refund', failedRefunds.length, 'item(s) for order', orderNumber, ':', JSON.stringify(failedRefunds));
  }

  return { failedRefunds };
}

// Update stock for merch items (with optimistic concurrency)
export async function updateMerchStock(items: CartItem[], orderNumber: string, orderId: string, idToken?: string, env?: Record<string, unknown>): Promise<void> {
  const now = new Date().toISOString();
  const MAX_RETRIES = 3;

  for (const item of items) {
    if (item.type === 'merch' && item.productId) {
      let stockUpdated = false;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          log.info('[order-utils] Updating stock for merch item:', item.name, 'qty:', item.quantity, 'attempt:', attempt + 1);

          const productData = await getDocument('merch', item.productId);

          if (!productData) break;

          const variantStock = productData.variantStock || {};

          // Build variant key from size and color
          const size = (item.size || 'onesize').toLowerCase().replace(/\s/g, '-');
          const color = (item.color || 'default').toLowerCase().replace(/\s/g, '-');
          const variantKey = size + '_' + color;

          // Exact match only - no heuristic guessing to avoid updating wrong variant
          if (!variantStock[variantKey]) {
            log.error('[order-utils] Variant key not found:', variantKey, 'for item:', item.name, 'available keys:', Object.keys(variantStock));
            break;
          }

          const variant = variantStock[variantKey];
          if (!variant) break;

          const previousStock = variant.stock || 0;
          const newStock = Math.max(0, previousStock - item.quantity);

          variant.stock = newStock;
          variant.sold = (variant.sold || 0) + item.quantity;
          variant.reserved = Math.max(0, (variant.reserved || 0) - item.quantity);
          variantStock[variantKey] = variant;

          // Calculate totals
          let totalStock = 0;
          let totalSold = 0;
          let totalReserved = 0;
          Object.values(variantStock).forEach((v: unknown) => {
            const variant = v as VariantStockEntry;
            totalStock += variant.stock || 0;
            totalSold += variant.sold || 0;
            totalReserved += (typeof v === 'object' ? variant.reserved || 0 : 0);
          });

          const updateData = {
            variantStock: variantStock,
            totalStock: totalStock,
            soldStock: totalSold,
            reservedStock: totalReserved,
            isLowStock: totalStock <= (productData.lowStockThreshold || 5) && totalStock > 0,
            isOutOfStock: totalStock === 0,
            updatedAt: now
          };

          try {
            // Conditional update - fails if document was modified since we read it
            if (productData._updateTime) {
              await updateDocumentConditional('merch', item.productId, updateData, productData._updateTime);
            } else {
              await updateDocument('merch', item.productId, updateData);
            }
            stockUpdated = true;
            log.info('[order-utils] ✓ Stock updated:', item.name, variantKey, previousStock, '->', newStock);
            break; // Success - exit retry loop
          } catch (conflictErr: unknown) {
            if (conflictErr instanceof Error && conflictErr.message.includes('CONFLICT') && attempt < MAX_RETRIES - 1) {
              log.info('[order-utils] Stock conflict for', item.name, '- retrying...');
              continue;
            }
            throw conflictErr;
          }
        } catch (stockErr: unknown) {
          if (attempt === MAX_RETRIES - 1) {
            log.error('[order-utils] Stock update error after', MAX_RETRIES, 'attempts:', stockErr);
          }
        }
      }

      if (stockUpdated) {
        // Record stock movement
        try {
          const productData = await getDocument('merch', item.productId);
          const size = (item.size || 'onesize').toLowerCase().replace(/\s/g, '-');
          const color = (item.color || 'default').toLowerCase().replace(/\s/g, '-');
          const variantKey = size + '_' + color;
          const variant = productData?.variantStock?.[variantKey];

          await addDocument('merch-stock-movements', {
            productId: item.productId,
            productName: item.name,
            sku: productData?.sku,
            variantKey: variantKey,
            variantSku: variant?.sku,
            type: 'sell',
            quantity: item.quantity,
            stockDelta: -item.quantity,
            previousStock: (variant?.stock || 0) + item.quantity,
            newStock: variant?.stock || 0,
            orderId: orderId,
            orderNumber: orderNumber,
            notes: 'Order ' + orderNumber,
            createdAt: now,
            createdBy: 'system'
          }, idToken);
        } catch (movementErr: unknown) {
          log.error('[order-utils] Stock movement log error:', movementErr);
        }

        // Sync to D1
        const db = env?.DB;
        if (db) {
          try {
            clearCache(`doc:merch:${item.productId}`);
            const updatedProduct = await getDocument('merch', item.productId);
            if (updatedProduct) {
              await d1UpsertMerch(db, item.productId, updatedProduct);
              log.info('[order-utils] ✓ D1 synced for:', item.name);
            }
          } catch (d1Error: unknown) {
            log.error('[order-utils] D1 sync failed (non-critical):', d1Error);
          }
        }

        // Update supplier stats atomically
        try {
          const productData = await getDocument('merch', item.productId);
          if (productData?.supplierId) {
            const supplierRevenue = (productData.retailPrice || item.price) * item.quantity * ((productData.supplierCut || 0) / 100);
            await atomicIncrement('merch-suppliers', productData.supplierId, {
              totalStock: -item.quantity,
              totalSold: item.quantity,
              totalRevenue: supplierRevenue
            });
          }
        } catch (supplierErr: unknown) {
          log.info('[order-utils] Could not update supplier stats');
        }
      }
    }
  }
}

// Send order confirmation email
export async function sendOrderConfirmationEmail(
  order: Record<string, unknown>,
  orderId: string,
  orderNumber: string,
  env: Record<string, unknown>
): Promise<void> {
  const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

  // Attempting to send confirmation email

  if (!RESEND_API_KEY || !order.customer?.email) {
    log.warn('[sendEmail] Skipping email - no API key or no customer email');
    return;
  }

  try {
    // Sending confirmation email
    const shortOrderNumber = getShortOrderNumber(orderNumber);
    const emailHtml = buildOrderConfirmationEmail(orderId, shortOrderNumber, order);

    // Email HTML generated

    const result = await sendResendEmail({
      apiKey: RESEND_API_KEY,
      from: 'Fresh Wax <orders@freshwax.co.uk>',
      to: [order.customer.email],
      bcc: ['freshwaxonline@gmail.com'],
      subject: 'Order Confirmed - ' + shortOrderNumber,
      html: emailHtml,
      template: 'order-confirmation',
      db: env?.DB,
    });

    if (result.success) {
      // Email sent successfully
    } else {
      log.error('[sendEmail] Email failed:', result.error);
    }
  } catch (emailError: unknown) {
    log.error('[sendEmail] ❌ Exception:', emailError);
  }
}

// Send vinyl fulfillment email to stockist
export async function sendVinylFulfillmentEmail(
  order: Record<string, unknown>,
  orderId: string,
  orderNumber: string,
  vinylItems: CartItem[],
  env: Record<string, unknown>
): Promise<void> {
  const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
  const STOCKIST_EMAIL = env?.VINYL_STOCKIST_EMAIL || import.meta.env.VINYL_STOCKIST_EMAIL || 'stockist@freshwax.co.uk';

  if (!RESEND_API_KEY || !STOCKIST_EMAIL) return;

  try {
    log.info('[order-utils] Sending vinyl fulfillment email to stockist:', STOCKIST_EMAIL);
    const fulfillmentHtml = buildStockistFulfillmentEmail(orderId, orderNumber, order, vinylItems);

    const result = await sendResendEmail({
      apiKey: RESEND_API_KEY,
      from: 'Fresh Wax Orders <orders@freshwax.co.uk>',
      to: [STOCKIST_EMAIL],
      bcc: ['freshwaxonline@gmail.com'],
      subject: 'VINYL FULFILLMENT REQUIRED - ' + orderNumber,
      html: fulfillmentHtml,
      template: 'vinyl-fulfillment',
      db: env?.DB,
    });

    if (result.success) {
      log.info('[order-utils] Stockist email sent!');
    } else {
      log.error('[order-utils] Stockist email failed:', result.error);
    }
  } catch (stockistError: unknown) {
    log.error('[order-utils] Stockist email error:', stockistError);
  }
}

// Send digital sale notification to artists
export async function sendDigitalSaleEmails(
  order: Record<string, unknown>,
  orderNumber: string,
  digitalItems: CartItem[],
  env: Record<string, unknown>
): Promise<void> {
  const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return;

  // Group items by artist email
  const itemsByArtist: { [email: string]: CartItem[] } = {};
  for (const item of digitalItems) {
    const artistEmail = item.artistEmail;
    if (artistEmail) {
      if (!itemsByArtist[artistEmail]) {
        itemsByArtist[artistEmail] = [];
      }
      itemsByArtist[artistEmail].push(item);
    }
  }

  // Send email to each artist
  for (const [artistEmail, items] of Object.entries(itemsByArtist)) {
    try {
      log.info('[order-utils] Sending digital sale email to artist:', artistEmail);
      const digitalHtml = buildDigitalSaleEmail(orderNumber, order, items);

      await sendResendEmail({
        apiKey: RESEND_API_KEY,
        from: 'Fresh Wax <orders@freshwax.co.uk>',
        to: [artistEmail],
        bcc: ['freshwaxonline@gmail.com'],
        subject: 'Digital Sale! ' + orderNumber,
        html: digitalHtml,
        template: 'digital-sale-artist',
        db: env?.DB,
      });
      log.info('[order-utils] Digital sale email sent to:', artistEmail);
    } catch (digitalError: unknown) {
      log.error('[order-utils] Digital sale email error:', digitalError);
    }
  }
}

// Send merch sale notification to sellers
export async function sendMerchSaleEmails(
  order: Record<string, unknown>,
  orderNumber: string,
  merchItems: CartItem[],
  env: Record<string, unknown>
): Promise<void> {
  const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return;

  // Group items by seller email
  const itemsBySeller: { [email: string]: CartItem[] } = {};
  for (const item of merchItems) {
    const sellerEmail = item.stockistEmail || item.artistEmail || item.sellerEmail;
    if (sellerEmail) {
      if (!itemsBySeller[sellerEmail]) {
        itemsBySeller[sellerEmail] = [];
      }
      itemsBySeller[sellerEmail].push(item);
    }
  }

  // Send email to each seller
  for (const [sellerEmail, items] of Object.entries(itemsBySeller)) {
    try {
      log.info('[order-utils] Sending merch sale email to seller:', sellerEmail);
      const merchHtml = buildMerchSaleEmail(orderNumber, order, items);

      await sendResendEmail({
        apiKey: RESEND_API_KEY,
        from: 'Fresh Wax Orders <orders@freshwax.co.uk>',
        to: [sellerEmail],
        bcc: ['freshwaxonline@gmail.com'],
        subject: 'Merch Order! ' + orderNumber,
        html: merchHtml,
        template: 'merch-sale-seller',
        db: env?.DB,
      });
      log.info('[order-utils] Merch sale email sent to:', sellerEmail);
    } catch (merchError: unknown) {
      log.error('[order-utils] Merch sale email error:', merchError);
    }
  }
}

// Update customer order count
export async function updateCustomerOrderCount(userId: string): Promise<void> {
  if (!userId) return;

  try {
    await atomicIncrement('users', userId, { orderCount: 1 });
    await updateDocument('users', userId, {
      lastOrderAt: new Date().toISOString()
    });
  } catch (e: unknown) {
    log.error('[order-utils] Error updating customer:', e);
  }
}

// Main function to create a complete order
export interface CreateOrderParams {
  orderData: {
    customer: {
      email: string;
      firstName: string;
      lastName: string;
      phone?: string;
      userId?: string;
    };
    shipping?: {
      address1: string;
      address2?: string;
      city: string;
      county?: string;
      postcode: string;
      country: string;
    };
    items: CartItem[];
    totals: {
      subtotal: number;
      shipping: number;
      freshWaxFee?: number;
      stripeFee?: number;
      serviceFees?: number;
      total: number;
    };
    hasPhysicalItems: boolean;
    paymentMethod: string;
    paymentIntentId?: string;
    paypalOrderId?: string;
  };
  env: Record<string, unknown>;
  idToken?: string;
}

export interface CreateOrderResult {
  success: boolean;
  orderId?: string;
  orderNumber?: string;
  error?: string;
}

export async function createOrder(params: CreateOrderParams): Promise<CreateOrderResult> {
  const { orderData, env, idToken } = params;
  const now = new Date().toISOString();
  const orderNumber = generateOrderNumber();

  try {
    // Process items with download URLs
    const itemsWithDownloads = await processItemsWithDownloads(orderData.items);

    // Check for pre-orders
    const hasPreOrderItems = itemsWithDownloads.some((item: CartItem) => item.isPreOrder === true);
    const preOrderReleaseDates = itemsWithDownloads
      .filter((item: CartItem) => item.isPreOrder && item.releaseDate)
      .map((item: CartItem) => new Date(item.releaseDate as string));
    const latestPreOrderDate = preOrderReleaseDates.length > 0
      ? new Date(Math.max(...preOrderReleaseDates.map((d: Date) => d.getTime()))).toISOString()
      : null;

    // Create order document
    const order = {
      orderNumber,
      customer: {
        email: orderData.customer.email,
        firstName: orderData.customer.firstName,
        lastName: orderData.customer.lastName,
        phone: orderData.customer.phone || '',
        userId: orderData.customer.userId || null
      },
      customerId: orderData.customer.userId || null,
      shipping: orderData.shipping || null,
      items: itemsWithDownloads,
      totals: {
        subtotal: orderData.totals.subtotal,
        shipping: orderData.totals.shipping,
        freshWaxFee: orderData.totals.freshWaxFee || 0,
        stripeFee: orderData.totals.stripeFee || 0,
        serviceFees: orderData.totals.serviceFees || 0,
        total: orderData.totals.total
      },
      hasPhysicalItems: orderData.hasPhysicalItems,
      hasPreOrderItems,
      preOrderDeliveryDate: latestPreOrderDate,
      paymentMethod: orderData.paymentMethod,
      paymentIntentId: orderData.paymentIntentId || null,
      paypalOrderId: orderData.paypalOrderId || null,
      paymentStatus: 'completed',
      // Use both status and orderStatus for compatibility
      // status is used by UI pages and update-order-status API
      // orderStatus is legacy field kept for backward compatibility
      status: hasPreOrderItems ? 'awaiting_release' : (orderData.hasPhysicalItems ? 'processing' : 'completed'),
      orderStatus: hasPreOrderItems ? 'awaiting_release' : (orderData.hasPhysicalItems ? 'processing' : 'completed'),
      createdAt: now,
      updatedAt: now
    };

    // Save to Firebase
    const orderRef = await addDocument('orders', order, idToken);
    log.info('[createOrder] Order created:', orderNumber, orderRef.id);

    // Update stock for merch items (includes D1 sync)
    await updateMerchStock(order.items, orderNumber, orderRef.id, idToken, env);

    // Update stock for vinyl items
    await updateVinylStock(order.items, orderNumber, orderRef.id, idToken);

    // Process vinyl crates orders (marketplace items from sellers)
    await processVinylCratesOrders(
      order.items,
      orderNumber,
      orderRef.id,
      order.customer,
      order.shipping,
      env,
      idToken
    );

    // Send confirmation email
    await sendOrderConfirmationEmail(order, orderRef.id, orderNumber, env);

    // Send vinyl fulfillment email if applicable
    const vinylItems = order.items.filter((item: CartItem) => item.type === 'vinyl');
    if (vinylItems.length > 0) {
      await sendVinylFulfillmentEmail(order, orderRef.id, orderNumber, vinylItems, env);
    }

    // Send digital sale emails
    const digitalItems = order.items.filter((item: CartItem) =>
      item.type === 'track' || item.type === 'digital' || item.type === 'release'
    );
    if (digitalItems.length > 0) {
      await sendDigitalSaleEmails(order, orderNumber, digitalItems, env);
    }

    // Send merch sale emails
    const merchItems = order.items.filter((item: CartItem) => item.type === 'merch');
    if (merchItems.length > 0) {
      await sendMerchSaleEmails(order, orderNumber, merchItems, env);
    }

    // Update customer order count
    if (orderData.customer.userId) {
      await updateCustomerOrderCount(orderData.customer.userId);
    }

    return {
      success: true,
      orderId: orderRef.id,
      orderNumber
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error('[createOrder] ❌ ERROR:', errorMessage);
    log.error('[createOrder] Stack:', error instanceof Error ? error.stack : 'no stack');
    return {
      success: false,
      error: errorMessage
    };
  }
}

// ============================================
// EMAIL TEMPLATES
// ============================================

function buildOrderConfirmationEmail(orderId: string, orderNumber: string, order: Record<string, unknown>): string {
  // Build items HTML - only show image for merch items
  let itemsHtml = '';
  for (const item of order.items) {
    const isMerchItem = item.type === 'merch';
    const itemImage = isMerchItem ? (item.image || item.artwork || '') : '';

    let typeLabel = '';
    if (item.type === 'digital') typeLabel = 'Digital Download';
    else if (item.type === 'track') typeLabel = 'Single Track';
    else if (item.type === 'vinyl') typeLabel = 'Vinyl Record';
    else if (item.type === 'merch') typeLabel = 'Merchandise';
    else typeLabel = escapeHtml(item.type) || '';

    const imageHtml = itemImage ? '<img src="' + escapeHtml(itemImage) + '" alt="' + escapeHtml(item.name) + '" width="70" height="70" style="border-radius: 8px; display: block; margin: 0 auto;">' : '';

    itemsHtml += '<tr><td style="padding: 16px 0; border-bottom: 1px solid #e5e7eb;">' +
      '<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
      (itemImage ? '<td width="86" style="padding-right: 16px; vertical-align: middle; text-align: center;">' + imageHtml + '</td>' : '') +
      '<td style="vertical-align: middle; text-align: left;">' +
      '<div style="font-weight: 600; color: #111; font-size: 15px; margin-bottom: 4px; text-align: left;">' + escapeHtml(item.name) + '</div>' +
      '<div style="font-size: 13px; color: #6b7280; text-align: left;">' +
      typeLabel +
      (item.size ? ' • Size: ' + escapeHtml(item.size) : '') +
      (item.color ? ' • ' + escapeHtml(item.color) : '') +
      (item.quantity > 1 ? ' • Qty: ' + item.quantity : '') +
      '</div></td>' +
      '<td width="80" style="text-align: right; font-weight: 600; color: #111; vertical-align: middle;">£' + (item.price * item.quantity).toFixed(2) + '</td>' +
      '</tr></table></td></tr>';
  }

  const shippingSection = order.shipping ?
    '<tr><td style="padding: 20px 24px; background: #f9fafb; border-radius: 8px; margin-top: 16px;">' +
    '<div style="font-weight: 700; color: #111; margin-bottom: 10px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">Shipping To</div>' +
    '<div style="color: #374151; line-height: 1.6; font-size: 14px;">' +
    escapeHtml(order.customer.firstName) + ' ' + escapeHtml(order.customer.lastName) + '<br>' +
    escapeHtml(order.shipping.address1) + '<br>' +
    (order.shipping.address2 ? escapeHtml(order.shipping.address2) + '<br>' : '') +
    escapeHtml(order.shipping.city) + ', ' + escapeHtml(order.shipping.postcode) + '<br>' +
    (order.shipping.county ? escapeHtml(order.shipping.county) + '<br>' : '') +
    escapeHtml(order.shipping.country) +
    '</div></td></tr><tr><td style="height: 16px;"></td></tr>' : '';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Order Confirmation</title></head>' +
    '<body style="margin: 0; padding: 0; background: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #f3f4f6;"><tr><td align="center" style="padding: 40px 20px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px;">' +
    '<tr><td style="background: #000000; padding: 32px 24px; border-radius: 12px 12px 0 0; text-align: center;">' +
    '<div style="font-size: 28px; font-weight: 800; letter-spacing: 1px;"><span style="color: #ffffff;">FRESH</span> <span style="color: #dc2626;">WAX</span></div>' +
    '<div style="font-size: 12px; color: #9ca3af; margin-top: 4px; letter-spacing: 2px;">JUNGLE • DRUM AND BASS</div>' +
    '</td></tr>' +
    '<tr><td style="background: #ffffff; padding: 32px 24px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td align="center" style="padding-bottom: 24px;">' +
    '<div style="width: 56px; height: 56px; background: #dcfce7; border-radius: 50%; margin: 0 auto 16px; line-height: 56px; text-align: center;">' +
    '<span style="color: #16a34a; font-size: 28px;">✓</span></div>' +
    '<h1 style="margin: 0; color: #111; font-size: 24px; font-weight: 700;">Order Confirmed!</h1>' +
    '<p style="margin: 8px 0 0; color: #6b7280; font-size: 14px;">Thank you for your purchase</p>' +
    '</td></tr>' +
    '<tr><td align="center" style="padding-bottom: 24px;">' +
    '<div style="display: inline-block; background: #f3f4f6; padding: 12px 24px; border-radius: 8px;">' +
    '<div style="color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Order Number</div>' +
    '<div style="color: #dc2626; font-size: 18px; font-weight: 700; margin-top: 4px;">' + escapeHtml(orderNumber) + '</div>' +
    '</div></td></tr>' +
    '<tr><td style="border-top: 1px solid #e5e7eb; padding-top: 24px;"></td></tr>' +
    '<tr><td style="padding-bottom: 12px; border-bottom: 1px solid #e5e7eb;">' +
    '<div style="font-weight: 700; color: #16a34a; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">Order Details</div>' +
    '</td></tr>' +
    '<tr><td><table cellpadding="0" cellspacing="0" border="0" width="100%">' + itemsHtml + '</table></td></tr>' +
    '<tr><td style="padding-top: 16px; border-top: 2px solid #dc2626;"><table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="color: #6b7280; padding: 8px 0; font-size: 14px;">Subtotal</td><td style="color: #111; text-align: right; padding: 8px 0; font-size: 14px;">£' + order.totals.subtotal.toFixed(2) + '</td></tr>' +
    '<tr><td style="color: #6b7280; padding: 8px 0; font-size: 14px;">Shipping</td><td style="color: #111; text-align: right; padding: 8px 0; font-size: 14px;">' +
    (order.hasPhysicalItems ? (order.totals.shipping === 0 ? 'FREE' : '£' + order.totals.shipping.toFixed(2)) : 'Digital delivery') + '</td></tr>' +
    (order.totals.stripeFee ? '<tr><td style="color: #9ca3af; padding: 8px 0; font-size: 13px;">Processing Fee</td><td style="color: #9ca3af; text-align: right; padding: 8px 0; font-size: 13px;">£' + order.totals.stripeFee.toFixed(2) + '</td></tr>' : '') +
    (order.totals.freshWaxFee ? '<tr><td style="color: #9ca3af; padding: 8px 0; font-size: 13px;"><span style="color: #111;">Fresh</span> <span style="color: #dc2626;">Wax</span> Tax</td><td style="color: #9ca3af; text-align: right; padding: 8px 0; font-size: 13px;">£' + order.totals.freshWaxFee.toFixed(2) + '</td></tr>' : '') +
    (order.totals.serviceFees && !order.totals.stripeFee && !order.totals.freshWaxFee ? '<tr><td style="color: #9ca3af; padding: 8px 0; font-size: 13px;">Service Fee</td><td style="color: #9ca3af; text-align: right; padding: 8px 0; font-size: 13px;">£' + order.totals.serviceFees.toFixed(2) + '</td></tr>' : '') +
    '<tr><td colspan="2" style="border-top: 2px solid #dc2626; padding-top: 12px;"></td></tr>' +
    '<tr><td style="color: #111; font-weight: 700; font-size: 16px; padding: 4px 0;">Total</td>' +
    '<td style="color: #dc2626; font-weight: 700; font-size: 20px; text-align: right; padding: 4px 0;">£' + order.totals.total.toFixed(2) + '</td></tr>' +
    '</table></td></tr>' +
    '<tr><td style="height: 24px;"></td></tr>' +
    shippingSection +
    '<tr><td align="center" style="padding: 24px 0 8px;">' +
    `<a href="${SITE_URL}" style="display: inline-block; padding: 14px 32px; background: #000000; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">Go Back to Store</a>` +
    '</td></tr>' +
    '</table></td></tr>' +
    '<tr><td align="center" style="padding: 24px 0;">' +
    '<div style="color: #6b7280; font-size: 13px; line-height: 1.6;">Question? Email us at <a href="mailto:contact@freshwax.co.uk" style="color: #111; text-decoration: underline;">contact@freshwax.co.uk</a></div>' +
    `<div style="margin-top: 12px;"><a href="${SITE_URL}" style="color: #9ca3af; font-size: 12px; text-decoration: none;">freshwax.co.uk</a></div>` +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

function buildStockistFulfillmentEmail(orderId: string, orderNumber: string, order: Record<string, unknown>, vinylItems: CartItem[]): string {
  const orderDate = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  let itemsHtml = '';
  for (const item of vinylItems) {
    itemsHtml += '<tr>' +
      '<td style="padding: 12px; border-bottom: 1px solid #e5e7eb; font-weight: 600;">' + escapeHtml(item.name) + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">' + (item.quantity || 1) + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">£' + (item.price * (item.quantity || 1)).toFixed(2) + '</td>' +
      '</tr>';
  }

  const vinylTotal = vinylItems.reduce((sum: number, item: CartItem) => sum + ((item.price || 0) * (item.quantity || 1)), 0);
  const isTestMode = order.paymentMethod === 'test_mode';
  const paymentStatusColor = order.paymentStatus === 'completed' ? '#16a34a' : '#f59e0b';
  const paymentStatusText = order.paymentStatus === 'completed' ? 'PAID' : 'PENDING';
  const paymentMethodText = isTestMode ? 'Test Mode' : (order.paymentMethod === 'stripe' ? 'Stripe' : order.paymentMethod === 'paypal' ? 'PayPal' : order.paymentMethod || 'Card');

  const artistPayment = order.totals.subtotal;
  const stripeFee = order.totals.stripeFee || 0;
  const freshWaxFee = order.totals.freshWaxFee || 0;
  const customerPaid = order.totals.total;

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>' +
    '<body style="margin: 0; padding: 0; background: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #f3f4f6;"><tr><td align="center" style="padding: 40px 20px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px;">' +
    '<tr><td style="background: #dc2626; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">' +
    '<div style="font-size: 24px; font-weight: 800; color: #fff; letter-spacing: 1px;">📦 VINYL FULFILLMENT REQUIRED</div>' +
    '<div style="font-size: 14px; color: rgba(255,255,255,0.9); margin-top: 8px;">Fresh Wax Order</div>' +
    '</td></tr>' +
    '<tr><td style="background: #ffffff; padding: 32px; border-radius: 0 0 12px 12px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding-bottom: 24px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: ' + (order.paymentStatus === 'completed' ? '#dcfce7' : '#fef3c7') + '; border: 2px solid ' + paymentStatusColor + '; border-radius: 8px;">' +
    '<tr><td style="padding: 16px;">' +
    '<div style="font-weight: 700; font-size: 12px; color: ' + paymentStatusColor + '; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">💳 Payment Confirmation</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding: 4px 0; color: #666; font-size: 13px;">Status:</td><td style="padding: 4px 0; font-weight: 700; color: ' + paymentStatusColor + '; font-size: 13px;">' + paymentStatusText + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #666; font-size: 13px;">Method:</td><td style="padding: 4px 0; font-weight: 600; color: #111; font-size: 13px;">' + paymentMethodText + '</td></tr>' +
    '</table>' +
    '<div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid ' + paymentStatusColor + ';">' +
    '<div style="font-weight: 700; font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Payment Breakdown</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding: 4px 0; color: #111; font-size: 14px; font-weight: 700;">Your Payment:</td><td style="padding: 4px 0; text-align: right; color: #16a34a; font-size: 14px; font-weight: 700;">£' + artistPayment.toFixed(2) + '</td></tr>' +
    '<tr><td colspan="2" style="padding: 4px 0 4px 0; border-top: 1px dashed #ccc;"></td></tr>' +
    '<tr><td style="padding: 4px 0; color: #9ca3af; font-size: 12px;">Processing Fee (paid by customer):</td><td style="padding: 4px 0; text-align: right; color: #9ca3af; font-size: 12px;">£' + stripeFee.toFixed(2) + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #9ca3af; font-size: 12px;">Fresh Wax 1% (paid by customer):</td><td style="padding: 4px 0; text-align: right; color: #9ca3af; font-size: 12px;">£' + freshWaxFee.toFixed(2) + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #666; font-size: 13px;">Customer Paid:</td><td style="padding: 4px 0; text-align: right; color: #111; font-size: 13px;">£' + customerPaid.toFixed(2) + '</td></tr>' +
    '</table></div>' +
    (isTestMode ? '<div style="margin-top: 12px; padding: 8px; background: #fef3c7; border-radius: 4px; font-size: 12px; color: #92400e;">⚠️ This is a test order - no real payment was processed</div>' : '') +
    '</td></tr></table></td></tr>' +
    '<tr><td style="padding-bottom: 24px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #fef2f2; border: 2px solid #dc2626; border-radius: 8px;">' +
    '<tr><td style="padding: 16px;">' +
    '<div style="font-weight: 700; font-size: 12px; color: #991b1b; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Order Details</div>' +
    '<div style="font-size: 24px; font-weight: 800; color: #000; margin-bottom: 4px;">' + escapeHtml(orderNumber) + '</div>' +
    '<div style="font-size: 14px; color: #666;">' + orderDate + '</div>' +
    '</td></tr></table></td></tr>' +
    '<tr><td style="padding-bottom: 24px;">' +
    '<div style="font-weight: 700; font-size: 12px; color: #dc2626; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; border-bottom: 2px solid #dc2626; padding-bottom: 8px;">📍 Ship To</div>' +
    '<div style="font-size: 16px; line-height: 1.6; color: #111;">' +
    '<strong>' + escapeHtml(order.customer.firstName) + ' ' + escapeHtml(order.customer.lastName) + '</strong><br>' +
    escapeHtml(order.shipping?.address1 || '') + '<br>' +
    (order.shipping?.address2 ? escapeHtml(order.shipping.address2) + '<br>' : '') +
    escapeHtml(order.shipping?.city || '') + '<br>' +
    escapeHtml(order.shipping?.postcode || '') + '<br>' +
    (order.shipping?.county ? escapeHtml(order.shipping.county) + '<br>' : '') +
    escapeHtml(order.shipping?.country || 'United Kingdom') +
    '</div>' +
    (order.customer.phone ? '<div style="margin-top: 8px; font-size: 14px; color: #666;">📞 ' + escapeHtml(order.customer.phone) + '</div>' : '') +
    '</td></tr>' +
    '<tr><td style="padding-bottom: 24px;">' +
    '<div style="font-weight: 700; font-size: 12px; color: #000; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; border-bottom: 2px solid #000; padding-bottom: 8px;">Vinyl to Pack & Ship</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr style="background: #f9fafb;">' +
    '<th style="padding: 10px 12px; text-align: left; font-size: 12px; text-transform: uppercase; color: #666;">Release</th>' +
    '<th style="padding: 10px 12px; text-align: center; font-size: 12px; text-transform: uppercase; color: #666;">Qty</th>' +
    '<th style="padding: 10px 12px; text-align: right; font-size: 12px; text-transform: uppercase; color: #666;">Value</th>' +
    '</tr>' +
    itemsHtml +
    '<tr style="background: #000;">' +
    '<td colspan="2" style="padding: 12px; color: #fff; font-weight: 700;">Total Vinyl Value</td>' +
    '<td style="padding: 12px; color: #fff; font-weight: 700; text-align: right;">£' + vinylTotal.toFixed(2) + '</td>' +
    '</tr></table></td></tr>' +
    '<tr><td style="padding: 16px; background: #f9fafb; border-radius: 8px;">' +
    '<div style="font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Customer Email</div>' +
    '<div style="font-size: 14px; color: #111;">' + escapeHtml(order.customer.email) + '</div>' +
    '</td></tr>' +
    '<tr><td style="padding-top: 24px;">' +
    '<div style="padding: 16px; background: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 0 8px 8px 0;">' +
    '<div style="font-weight: 700; color: #92400e; margin-bottom: 4px;">⚠️ Action Required</div>' +
    '<div style="font-size: 14px; color: #78350f; line-height: 1.5;">Please package and dispatch this order as soon as possible. Once shipped, please send tracking information to <a href="mailto:orders@freshwax.co.uk" style="color: #92400e;">orders@freshwax.co.uk</a></div>' +
    '</div></td></tr>' +
    '</table></td></tr>' +
    '<tr><td align="center" style="padding: 24px 0;">' +
    '<div style="color: #6b7280; font-size: 13px;">This is an automated fulfillment request from Fresh Wax</div>' +
    `<div style="margin-top: 8px;"><a href="${SITE_URL}" style="color: #dc2626; font-size: 12px; text-decoration: none; font-weight: 600;">freshwax.co.uk</a></div>` +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

function buildDigitalSaleEmail(orderNumber: string, order: Record<string, unknown>, digitalItems: CartItem[]): string {
  const digitalTotal = digitalItems.reduce((sum: number, item: CartItem) => sum + ((item.price || 0) * (item.quantity || 1)), 0);
  const subtotal = order.totals?.subtotal || digitalTotal;
  // Calculate fees that are deducted from artist share
  const freshWaxFee = digitalTotal * 0.01; // 1% Fresh Wax fee on these items
  const processingFee = (digitalTotal * 0.014) + (0.20 / Math.max(1, digitalItems.length)); // Processing fee split
  // Artist net earnings = gross - fees
  const artistNetEarnings = digitalTotal - freshWaxFee - processingFee;
  const customerPaid = order.totals?.total || subtotal;

  let itemsHtml = '';
  for (const item of digitalItems) {
    const typeLabel = item.type === 'track' ? 'Single Track' : 'Digital Release';
    itemsHtml += '<tr>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; color: #fff;">' + escapeHtml(item.name) + '<br><span style="font-size: 12px; color: #9ca3af;">' + typeLabel + '</span></td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; text-align: center; color: #fff;">' + item.quantity + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; text-align: right; font-weight: 600; color: #fff;">£' + (item.price * item.quantity).toFixed(2) + '</td>' +
      '</tr>';
  }

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>' +
    '<body style="margin: 0; padding: 0; background: #000; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #000;"><tr><td align="center" style="padding: 40px 20px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px;">' +
    '<tr><td style="background: #fff; padding: 32px 24px; border-radius: 12px 12px 0 0; text-align: center; border: 2px solid #dc2626; border-bottom: none;">' +
    '<div style="font-size: 28px; font-weight: 800; letter-spacing: 1px;"><span style="color: #000;">FRESH</span> <span style="color: #dc2626;">WAX</span></div>' +
    '<div style="font-size: 12px; color: #666; margin-top: 4px; letter-spacing: 2px;">JUNGLE • DRUM AND BASS</div>' +
    '</td></tr>' +
    '<tr><td style="background: #dc2626; padding: 20px 24px; text-align: center; border-left: 2px solid #dc2626; border-right: 2px solid #dc2626;">' +
    '<div style="font-size: 22px; font-weight: 800; color: #fff; letter-spacing: 1px;">🎵 DIGITAL SALE!</div>' +
    '<div style="font-size: 14px; color: rgba(255,255,255,0.9); margin-top: 6px;">Order ' + escapeHtml(orderNumber) + '</div>' +
    '</td></tr>' +
    '<tr><td style="background: #111; padding: 24px; border-left: 2px solid #dc2626; border-right: 2px solid #dc2626; border-bottom: 2px solid #dc2626; border-radius: 0 0 12px 12px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding-bottom: 20px; text-align: center;">' +
    '<div style="font-size: 18px; font-weight: 700; color: #16a34a;">Someone bought your music!</div>' +
    '<div style="font-size: 14px; color: #9ca3af; margin-top: 4px;">Customer: ' + escapeHtml(order.customer.firstName) + ' ' + escapeHtml(order.customer.lastName) + '</div>' +
    '</td></tr>' +
    '<tr><td>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border: 1px solid #374151; border-radius: 8px; overflow: hidden; background: #1f2937;">' +
    '<tr style="background: #374151;">' +
    '<th style="padding: 12px; text-align: left; font-size: 12px; color: #9ca3af; text-transform: uppercase;">Item</th>' +
    '<th style="padding: 12px; text-align: center; font-size: 12px; color: #9ca3af; text-transform: uppercase;">Qty</th>' +
    '<th style="padding: 12px; text-align: right; font-size: 12px; color: #9ca3af; text-transform: uppercase;">Price</th>' +
    '</tr>' +
    itemsHtml +
    '<tr style="background: #dc2626;">' +
    '<td colspan="2" style="padding: 12px; color: #fff; font-weight: 700;">Your Earnings</td>' +
    '<td style="padding: 12px; color: #fff; font-weight: 700; text-align: right;">£' + artistNetEarnings.toFixed(2) + '</td>' +
    '</tr></table></td></tr>' +
    '<tr><td style="padding-top: 20px;">' +
    '<div style="padding: 16px; background: #1f2937; border-radius: 8px; border: 1px solid #374151;">' +
    '<div style="font-weight: 700; font-size: 12px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">Payment Breakdown</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding: 6px 0; color: #16a34a; font-size: 15px; font-weight: 700;">Your Payment:</td><td style="padding: 6px 0; text-align: right; color: #16a34a; font-size: 15px; font-weight: 700;">£' + artistNetEarnings.toFixed(2) + '</td></tr>' +
    '<tr><td colspan="2" style="padding: 8px 0; border-top: 1px dashed #374151;"></td></tr>' +
    '<tr><td style="padding: 4px 0; color: #6b7280; font-size: 13px;">Item Price:</td><td style="padding: 4px 0; text-align: right; color: #6b7280; font-size: 13px;">£' + digitalTotal.toFixed(2) + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #6b7280; font-size: 13px;">Processing Fee:</td><td style="padding: 4px 0; text-align: right; color: #6b7280; font-size: 13px;">-£' + processingFee.toFixed(2) + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #6b7280; font-size: 13px;"><span style="color: #fff;">Fresh</span> <span style="color: #dc2626;">Wax</span> Fee (1%):</td><td style="padding: 4px 0; text-align: right; color: #6b7280; font-size: 13px;">-£' + freshWaxFee.toFixed(2) + '</td></tr>' +
    '<tr><td colspan="2" style="padding: 8px 0; border-top: 1px dashed #374151;"></td></tr>' +
    '<tr><td style="padding: 6px 0; color: #fff; font-size: 15px; font-weight: 700;">Customer Paid:</td><td style="padding: 6px 0; text-align: right; color: #fff; font-size: 15px; font-weight: 700;">£' + customerPaid.toFixed(2) + '</td></tr>' +
    '</table></div></td></tr>' +
    '</table></td></tr>' +
    '<tr><td align="center" style="padding: 24px 0;">' +
    '<div style="color: #6b7280; font-size: 13px;">Automated notification from Fresh Wax</div>' +
    `<div style="margin-top: 8px;"><a href="${SITE_URL}" style="color: #dc2626; font-size: 12px; text-decoration: none; font-weight: 600;">freshwax.co.uk</a></div>` +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

function buildMerchSaleEmail(orderNumber: string, order: Record<string, unknown>, merchItems: CartItem[]): string {
  const merchTotal = merchItems.reduce((sum: number, item: CartItem) => sum + ((item.price || 0) * (item.quantity || 1)), 0);
  const subtotal = order.totals?.subtotal || merchTotal;
  // Calculate fees deducted from supplier share (5% for merch)
  const freshWaxFee = merchTotal * 0.05; // 5% Fresh Wax fee for merch
  const processingFee = (merchTotal * 0.014) + (0.20 / Math.max(1, merchItems.length)); // Processing fee split
  // Supplier net earnings = gross - fees
  const supplierNetEarnings = merchTotal - freshWaxFee - processingFee;
  const customerPaid = order.totals?.total || subtotal;

  let itemsHtml = '';
  for (const item of merchItems) {
    const details = [item.size ? 'Size: ' + escapeHtml(item.size) : '', escapeHtml(item.color) || ''].filter(Boolean).join(' • ');
    itemsHtml += '<tr>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; color: #fff;">' +
      (item.image ? '<img src="' + escapeHtml(item.image) + '" width="50" height="50" style="border-radius: 4px; margin-right: 10px; vertical-align: middle;">' : '') +
      escapeHtml(item.name) + (details ? '<br><span style="font-size: 12px; color: #9ca3af;">' + details + '</span>' : '') + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; text-align: center; color: #fff;">' + item.quantity + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; text-align: right; font-weight: 600; color: #fff;">£' + (item.price * item.quantity).toFixed(2) + '</td>' +
      '</tr>';
  }

  const shippingHtml = order.shipping ?
    '<tr><td style="padding-top: 20px;">' +
    '<div style="padding: 16px; background: #1f2937; border-radius: 8px; border: 1px solid #374151;">' +
    '<div style="font-weight: 700; color: #9ca3af; margin-bottom: 8px; font-size: 12px; text-transform: uppercase;">Ship To</div>' +
    '<div style="color: #fff; line-height: 1.5; font-size: 14px;">' +
    escapeHtml(order.customer.firstName) + ' ' + escapeHtml(order.customer.lastName) + '<br>' +
    escapeHtml(order.shipping.address1) + '<br>' +
    (order.shipping.address2 ? escapeHtml(order.shipping.address2) + '<br>' : '') +
    escapeHtml(order.shipping.city) + ', ' + escapeHtml(order.shipping.postcode) + '<br>' +
    escapeHtml(order.shipping.country) +
    '</div></div></td></tr>' : '';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>' +
    '<body style="margin: 0; padding: 0; background: #000; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #000;"><tr><td align="center" style="padding: 40px 20px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px;">' +
    '<tr><td style="background: #fff; padding: 32px 24px; border-radius: 12px 12px 0 0; text-align: center; border: 2px solid #dc2626; border-bottom: none;">' +
    '<div style="font-size: 28px; font-weight: 800; letter-spacing: 1px;"><span style="color: #000;">FRESH</span> <span style="color: #dc2626;">WAX</span></div>' +
    '<div style="font-size: 12px; color: #666; margin-top: 4px; letter-spacing: 2px;">JUNGLE • DRUM AND BASS</div>' +
    '</td></tr>' +
    '<tr><td style="background: #dc2626; padding: 20px 24px; text-align: center; border-left: 2px solid #dc2626; border-right: 2px solid #dc2626;">' +
    '<div style="font-size: 22px; font-weight: 800; color: #fff; letter-spacing: 1px;">👕 MERCH ORDER!</div>' +
    '<div style="font-size: 14px; color: rgba(255,255,255,0.9); margin-top: 6px;">Order ' + escapeHtml(orderNumber) + '</div>' +
    '</td></tr>' +
    '<tr><td style="background: #111; padding: 24px; border-left: 2px solid #dc2626; border-right: 2px solid #dc2626; border-bottom: 2px solid #dc2626; border-radius: 0 0 12px 12px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding-bottom: 20px; text-align: center;">' +
    '<div style="font-size: 18px; font-weight: 700; color: #16a34a;">Someone bought your merch!</div>' +
    '<div style="font-size: 14px; color: #9ca3af; margin-top: 4px;">Customer: ' + escapeHtml(order.customer.firstName) + ' ' + escapeHtml(order.customer.lastName) + '</div>' +
    '</td></tr>' +
    '<tr><td>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border: 1px solid #374151; border-radius: 8px; overflow: hidden; background: #1f2937;">' +
    '<tr style="background: #374151;">' +
    '<th style="padding: 12px; text-align: left; font-size: 12px; color: #9ca3af; text-transform: uppercase;">Item</th>' +
    '<th style="padding: 12px; text-align: center; font-size: 12px; color: #9ca3af; text-transform: uppercase;">Qty</th>' +
    '<th style="padding: 12px; text-align: right; font-size: 12px; color: #9ca3af; text-transform: uppercase;">Price</th>' +
    '</tr>' +
    itemsHtml +
    '<tr style="background: #dc2626;">' +
    '<td colspan="2" style="padding: 12px; color: #fff; font-weight: 700;">Your Earnings</td>' +
    '<td style="padding: 12px; color: #fff; font-weight: 700; text-align: right;">£' + supplierNetEarnings.toFixed(2) + '</td>' +
    '</tr></table></td></tr>' +
    shippingHtml +
    '<tr><td style="padding-top: 20px;">' +
    '<div style="padding: 16px; background: #1f2937; border-radius: 8px; border: 1px solid #374151;">' +
    '<div style="font-weight: 700; font-size: 12px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">Payment Breakdown</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding: 6px 0; color: #16a34a; font-size: 15px; font-weight: 700;">Your Payment:</td><td style="padding: 6px 0; text-align: right; color: #16a34a; font-size: 15px; font-weight: 700;">£' + supplierNetEarnings.toFixed(2) + '</td></tr>' +
    '<tr><td colspan="2" style="padding: 8px 0; border-top: 1px dashed #374151;"></td></tr>' +
    '<tr><td style="padding: 4px 0; color: #6b7280; font-size: 13px;">Item Price:</td><td style="padding: 4px 0; text-align: right; color: #6b7280; font-size: 13px;">£' + merchTotal.toFixed(2) + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #6b7280; font-size: 13px;">Processing Fee:</td><td style="padding: 4px 0; text-align: right; color: #6b7280; font-size: 13px;">-£' + processingFee.toFixed(2) + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #6b7280; font-size: 13px;"><span style="color: #fff;">Fresh</span> <span style="color: #dc2626;">Wax</span> Fee (5%):</td><td style="padding: 4px 0; text-align: right; color: #6b7280; font-size: 13px;">-£' + freshWaxFee.toFixed(2) + '</td></tr>' +
    '<tr><td colspan="2" style="padding: 8px 0; border-top: 1px dashed #374151;"></td></tr>' +
    '<tr><td style="padding: 6px 0; color: #fff; font-size: 15px; font-weight: 700;">Customer Paid:</td><td style="padding: 6px 0; text-align: right; color: #fff; font-size: 15px; font-weight: 700;">£' + customerPaid.toFixed(2) + '</td></tr>' +
    '</table></div></td></tr>' +
    '<tr><td style="padding-top: 20px;">' +
    '<div style="padding: 16px; background: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 0 8px 8px 0;">' +
    '<div style="font-weight: 700; color: #92400e; margin-bottom: 4px;">⚠️ Action Required</div>' +
    '<div style="font-size: 14px; color: #78350f; line-height: 1.5;">Please package and dispatch this order. Once shipped, send tracking info to <a href="mailto:orders@freshwax.co.uk" style="color: #92400e;">orders@freshwax.co.uk</a></div>' +
    '</div></td></tr>' +
    '<tr><td style="padding-top: 16px;">' +
    '<div style="font-size: 12px; color: #9ca3af;">Customer email: <strong style="color: #fff;">' + escapeHtml(order.customer.email) + '</strong></div>' +
    '</td></tr>' +
    '</table></td></tr>' +
    '<tr><td align="center" style="padding: 24px 0;">' +
    '<div style="color: #6b7280; font-size: 13px;">Automated notification from Fresh Wax</div>' +
    `<div style="margin-top: 8px;"><a href="${SITE_URL}" style="color: #dc2626; font-size: 12px; text-decoration: none; font-weight: 600;">freshwax.co.uk</a></div>` +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';
}
