// src/lib/order/price-validation.ts
// Server-side price validation for order items — prevents client-side price manipulation
// Extracted from create-order.ts (pure extraction, zero behavior changes)

import { getDocument } from '../firebase-rest';
import { createLogger } from '../api-utils';

const log = createLogger('create-order');

// Minimal type for track data from Firestore
interface TrackData {
  id?: string;
  trackId?: string;
  trackNumber?: number;
  trackName?: string;
  name?: string;
  price?: number;
  mp3Url?: string;
  wavUrl?: string;
  [key: string]: unknown;
}

export interface PriceValidationResult {
  validatedItems: Record<string, unknown>[];
  serverSubtotal: number;
  hasMismatch: boolean;
  validationError?: string;
}

// Validate item prices server-side to prevent manipulation
export async function validateOrderPrices(items: Record<string, unknown>[]): Promise<PriceValidationResult> {
  const validatedItems: Record<string, unknown>[] = [];
  let serverSubtotal = 0;
  let hasMismatch = false;

  // Pre-fetch all needed documents in parallel to avoid N+1 sequential calls
  const merchIds = items.filter(i => (i.type || 'digital') === 'merch' && i.productId).map(i => i.productId);
  const releaseIds = items.filter(i => {
    const t = i.type || 'digital';
    if (t === 'vinyl' && i.sellerId && !i.releaseId) return false; // crates items use vinylListings
    return ['digital', 'track', 'vinyl', 'release'].includes(t) && (i.releaseId || i.productId || i.id);
  }).map(i => i.releaseId || i.productId || i.id);
  const listingIds = items.filter(i => (i.type || 'digital') === 'vinyl' && i.sellerId && !i.releaseId).map(i => i.id || i.productId).filter(Boolean);

  // Deduplicate IDs
  const uniqueMerchIds = [...new Set(merchIds)];
  const uniqueReleaseIds = [...new Set(releaseIds)];
  const uniqueListingIds = [...new Set(listingIds)];

  // Use Promise.allSettled to handle partial failures gracefully —
  // a single failed Firestore fetch should not crash the entire order
  const [merchResults, releaseResults, listingResults] = await Promise.allSettled([
    Promise.allSettled(uniqueMerchIds.map(id => getDocument('merch', id))),
    Promise.allSettled(uniqueReleaseIds.map(id => getDocument('releases', id))),
    Promise.allSettled(uniqueListingIds.map(id => getDocument('vinylListings', id)))
  ]);

  // If an entire category of fetches failed, treat all its docs as null (not found)
  const merchSettled = merchResults.status === 'fulfilled' ? merchResults.value : uniqueMerchIds.map(() => ({ status: 'rejected' as const, reason: 'batch failed' }));
  const releaseSettled = releaseResults.status === 'fulfilled' ? releaseResults.value : uniqueReleaseIds.map(() => ({ status: 'rejected' as const, reason: 'batch failed' }));
  const listingSettled = listingResults.status === 'fulfilled' ? listingResults.value : uniqueListingIds.map(() => ({ status: 'rejected' as const, reason: 'batch failed' }));

  // Build lookup maps — rejected fetches map to null, caught by "Product not found" checks below
  const merchMap = new Map(uniqueMerchIds.map((id, i) => [id, merchSettled[i].status === 'fulfilled' ? merchSettled[i].value : null]));
  const releaseMap = new Map(uniqueReleaseIds.map((id, i) => [id, releaseSettled[i].status === 'fulfilled' ? releaseSettled[i].value : null]));
  const listingMap = new Map(uniqueListingIds.map((id, i) => [id, listingSettled[i].status === 'fulfilled' ? listingSettled[i].value : null]));

  // Pre-fetch artist docs for vinyl items that need shipping defaults
  const artistIdsNeeded: string[] = [];
  for (const item of items) {
    const itemType = item.type || 'digital';
    if (itemType === 'vinyl' && !(item.sellerId && !item.releaseId)) {
      const releaseId = item.releaseId || item.productId || item.id;
      if (releaseId) {
        const release = releaseMap.get(releaseId);
        const artistId = item.artistId || release?.artistId;
        if (artistId) artistIdsNeeded.push(artistId);
      }
    }
  }
  const uniqueArtistIds = [...new Set(artistIdsNeeded)];
  const artistSettled = await Promise.allSettled(uniqueArtistIds.map(id => getDocument('artists', id)));
  const artistMap = new Map(uniqueArtistIds.map((id, i) => [id, artistSettled[i].status === 'fulfilled' ? artistSettled[i].value : null]));

  for (const item of items) {
    let serverPrice = item.price;
    const itemType = item.type || 'digital';
    const quantity = item.quantity || 1;
    const extraFields: Record<string, unknown> = {};

    try {
      if (itemType === 'merch' && item.productId) {
        const product = merchMap.get(item.productId);
        if (!product) {
          return { validatedItems: [], serverSubtotal: 0, hasMismatch: true, validationError: `Product not found: ${item.name}` };
        }
        serverPrice = product.salePrice || product.retailPrice || product.price || item.price;
      } else if (itemType === 'vinyl') {
        if (item.sellerId && !item.releaseId) {
          // Vinyl crates item
          const listingId = item.id || item.productId;
          if (listingId) {
            const listing = listingMap.get(listingId);
            if (!listing) {
              return { validatedItems: [], serverSubtotal: 0, hasMismatch: true, validationError: `Product not found: ${item.name}` };
            }
            serverPrice = listing.price || item.price;
            // Pull shipping cost from listing for vinyl crates
            extraFields.shippingCost = listing.shippingCost ?? null;
          }
        } else {
          const releaseId = item.releaseId || item.productId || item.id;
          if (releaseId) {
            const release = releaseMap.get(releaseId);
            if (!release) {
              return { validatedItems: [], serverSubtotal: 0, hasMismatch: true, validationError: `Product not found: ${item.name}` };
            }
            serverPrice = release.vinylPrice || release.price || item.price;
            // Pull server-side shipping rates from release
            extraFields.serverVinylShippingUK = release.vinylShippingUK ?? null;
            extraFields.serverVinylShippingEU = release.vinylShippingEU ?? null;
            extraFields.serverVinylShippingIntl = release.vinylShippingIntl ?? null;
            // Fetch artist-level shipping defaults as fallback
            const artistId = item.artistId || release.artistId;
            if (artistId) {
              const artist = artistMap.get(artistId);
              if (artist) {
                extraFields.serverArtistShippingUK = artist.vinylShippingUK ?? null;
                extraFields.serverArtistShippingEU = artist.vinylShippingEU ?? null;
                extraFields.serverArtistShippingIntl = artist.vinylShippingIntl ?? null;
              }
              extraFields.artistId = artistId;
            }
          }
        }
      } else if (itemType === 'track' && item.trackId) {
        const releaseId = item.releaseId || item.productId || item.id;
        if (releaseId) {
          const release = releaseMap.get(releaseId);
          if (!release) {
            return { validatedItems: [], serverSubtotal: 0, hasMismatch: true, validationError: `Product not found: ${item.name}` };
          }
          const track = (release.tracks || []).find((t: TrackData) =>
            t.id === item.trackId || t.trackId === item.trackId
          );
          serverPrice = track?.price || release.trackPrice || 0.99;
        }
      } else if (itemType === 'digital' || itemType === 'release') {
        const releaseId = item.releaseId || item.productId || item.id;
        if (releaseId) {
          const release = releaseMap.get(releaseId);
          if (!release) {
            return { validatedItems: [], serverSubtotal: 0, hasMismatch: true, validationError: `Product not found: ${item.name}` };
          }
          serverPrice = release.price || release.digitalPrice;
          if (serverPrice == null || serverPrice <= 0) {
            return { validatedItems: [], serverSubtotal: 0, hasMismatch: true, validationError: `Unable to verify price for ${item.name}. Please try again.` };
          }
        }
      }

      // Check for price mismatch (allow 1p rounding difference)
      if (Math.abs(serverPrice - item.price) > 0.01) {
        log.warn('[create-order] SECURITY: Price mismatch for', item.name, '- Client:', item.price, 'Server:', serverPrice);
        hasMismatch = true;
      }

      serverSubtotal += serverPrice * quantity;
      validatedItems.push({ ...item, price: serverPrice, originalClientPrice: item.price, ...extraFields });
    } catch (err: unknown) {
      log.error('[create-order] Error validating price for', item.name, err);
      // SECURITY: Reject items where price validation fails — never trust client price
      return { validatedItems: [], serverSubtotal: 0, hasMismatch: true, validationError: `Price validation failed for ${item.name}. Please try again.` };
    }
  }

  return { validatedItems, serverSubtotal: Math.round(serverSubtotal * 100) / 100, hasMismatch };
}
