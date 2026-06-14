// src/lib/order/stock-validation.ts
// Stock validation and price verification for checkout flows

import { getDocument } from '../firebase-rest';
import { log } from './types';
import type { CartItem } from './types';

// Validate stock availability before checkout
export async function validateStock(items: CartItem[]): Promise<{ available: boolean, unavailableItems: string[] }> {
  const unavailableItems: string[] = [];

  // Pre-fetch all needed documents in parallel to avoid N+1 sequential calls
  // Use throwOnError=true so callers know if Firebase is unreachable vs "item not found"
  const merchIds = [...new Set(items.filter(i => (i.type || 'digital') === 'merch' && i.productId).map(i => i.productId))];
  const releaseIds = [...new Set(items.filter(i => (i.type || 'digital') === 'vinyl' && !(i.sellerId && !i.releaseId) && (i.releaseId || i.productId || i.id)).map(i => i.releaseId || i.productId || i.id))];
  const listingIds = [...new Set(items.filter(i => (i.type || 'digital') === 'vinyl' && i.sellerId && !i.releaseId).map(i => i.id || i.productId).filter(Boolean))];

  // Use Promise.allSettled to handle partial failures gracefully —
  // a single failed Firestore fetch should not crash stock validation
  const [merchResults, releaseResults, listingResults] = await Promise.allSettled([
    Promise.allSettled(merchIds.map(id => getDocument('merch', id, undefined, true))),
    Promise.allSettled(releaseIds.map(id => getDocument('releases', id, undefined, true))),
    Promise.allSettled(listingIds.map(id => getDocument('vinylListings', id, undefined, true)))
  ]);

  // If an entire category of fetches failed, treat all its docs as null (not found)
  const merchSettled = merchResults.status === 'fulfilled' ? merchResults.value : merchIds.map(() => ({ status: 'rejected' as const, reason: 'batch failed' }));
  const releaseSettled = releaseResults.status === 'fulfilled' ? releaseResults.value : releaseIds.map(() => ({ status: 'rejected' as const, reason: 'batch failed' }));
  const listingSettled = listingResults.status === 'fulfilled' ? listingResults.value : listingIds.map(() => ({ status: 'rejected' as const, reason: 'batch failed' }));

  // Build lookup maps — rejected fetches map to null, caught by stock checks below
  const merchMap = new Map(merchIds.map((id, i) => [id, merchSettled[i].status === 'fulfilled' ? merchSettled[i].value : null]));
  const releaseMap = new Map(releaseIds.map((id, i) => [id, releaseSettled[i].status === 'fulfilled' ? releaseSettled[i].value : null]));
  const listingMap = new Map(listingIds.map((id, i) => [id, listingSettled[i].status === 'fulfilled' ? listingSettled[i].value : null]));

  for (const item of items) {
    const quantity = item.quantity || 1;
    const itemType = item.type || 'digital';

    if (itemType === 'merch' && item.productId) {
      const product = merchMap.get(item.productId);
      if (product) {
        if (item.size || item.color) {
          const size = (item.size || 'onesize').toLowerCase().replace(/\s/g, '-');
          const color = (item.color || 'default').toLowerCase().replace(/\s/g, '-');
          let variantKey = size + '_' + color;
          if (!product.variantStock?.[variantKey]) {
            const keys = Object.keys(product.variantStock || {});
            if (keys.length === 1) {
              variantKey = keys[0];
            } else if (keys.length > 1) {
              const sizeMatch = keys.find(k => k.startsWith(size + '_'));
              const colorMatch = keys.find(k => k.endsWith('_' + color));
              variantKey = sizeMatch || colorMatch || keys[0];
            }
          }
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
            // Multi-part vinyl: scope stock check to the part the cart line
            // names. Without this a buyer could put Part 2 (stock=0, not yet
            // pressed) in their cart and the check would pass against the
            // legacy vinylStock field — exactly the kind of state the variant
            // picker is meant to prevent.
            const parts = Array.isArray(release.vinylParts) ? release.vinylParts as Record<string, unknown>[] : [];
            if (item.vinylPartId && parts.length > 0) {
              const partIdx = parts.findIndex((_p, idx) => `part-${idx + 1}` === item.vinylPartId);
              const part = partIdx >= 0 ? parts[partIdx] : null;
              if (!part) {
                unavailableItems.push(`${item.name} - vinyl part not found`);
              } else if (part.pressed === false) {
                unavailableItems.push(`${item.name} - not yet pressed`);
              } else {
                const partStock = (part.stock as number) ?? 0;
                const partReserved = (part.reserved as number) ?? 0;
                const available = partStock - partReserved;
                if (available < quantity) {
                  unavailableItems.push(`${item.name} - only ${available} available`);
                }
              }
            } else {
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

  // Use Promise.allSettled so a single Firestore failure doesn't crash entire price validation
  const [merchResults, releaseResults, listingResults] = await Promise.allSettled([
    Promise.allSettled(merchIds.map(id => getDocument('merch', id))),
    Promise.allSettled(releaseIds.map(id => getDocument('releases', id))),
    Promise.allSettled(listingIds.map(id => getDocument('vinylListings', id)))
  ]);

  // If an entire category of fetches failed, treat all its docs as empty settled arrays
  const merchSettled = merchResults.status === 'fulfilled' ? merchResults.value : merchIds.map(() => ({ status: 'rejected' as const, reason: 'batch failed' }));
  const releaseSettled = releaseResults.status === 'fulfilled' ? releaseResults.value : releaseIds.map(() => ({ status: 'rejected' as const, reason: 'batch failed' }));
  const listingSettled = listingResults.status === 'fulfilled' ? listingResults.value : listingIds.map(() => ({ status: 'rejected' as const, reason: 'batch failed' }));

  // Build lookup maps — rejected fetches map to null, falls through to client price
  const merchMap = new Map(merchIds.map((id, i) => {
    const r = merchSettled[i];
    if (r.status === 'rejected') log.warn(prefix, 'Failed to fetch merch doc:', id, r.reason);
    return [id, r.status === 'fulfilled' ? r.value : null];
  }));
  const releaseMap = new Map(releaseIds.map((id, i) => {
    const r = releaseSettled[i];
    if (r.status === 'rejected') log.warn(prefix, 'Failed to fetch release doc:', id, r.reason);
    return [id, r.status === 'fulfilled' ? r.value : null];
  }));
  const listingMap = new Map(listingIds.map((id, i) => {
    const r = listingSettled[i];
    if (r.status === 'rejected') log.warn(prefix, 'Failed to fetch listing doc:', id, r.reason);
    return [id, r.status === 'fulfilled' ? r.value : null];
  }));

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
  // Use Promise.allSettled so one artist lookup failure doesn't block all price validation
  const artistSettled = await Promise.allSettled(uniqueArtistIds.map(id => getDocument('artists', id)));
  const artistMap = new Map(uniqueArtistIds.map((id, i) => {
    const r = artistSettled[i];
    if (r.status === 'rejected') log.warn(prefix, 'Failed to fetch artist doc:', id, r.reason);
    return [id, r.status === 'fulfilled' ? r.value : null];
  }));

  for (const item of items) {
    let serverPrice = item.price;
    const itemType = item.type || 'digital';

    try {
      if (itemType === 'merch' && item.productId) {
        const product = merchMap.get(item.productId);
        if (product) {
          serverPrice = product.salePrice || product.retailPrice || product.price || item.price;
          // Carry brand data for royalty tracking
          item.brandAccountId = product.brandAccountId || '';
          item.brandName = product.categoryName || 'Fresh Wax';
          // Carry supplier for payouts + per-supplier free-shipping rules
          item.supplierId = product.supplierId || null;
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
                // Multi-part: prefer the part's price so each Part can carry
                // its own price (e.g. a heavy double LP Part 2 could be £18
                // while Part 1 stays at £15). Falls back to release-level
                // vinylPrice when no part is named.
                const parts = Array.isArray(release.vinylParts) ? release.vinylParts as Record<string, unknown>[] : [];
                if (item.vinylPartId && parts.length > 0) {
                  const part = parts.find((_p, idx) => `part-${idx + 1}` === item.vinylPartId);
                  serverPrice = (part?.price as number) || release.vinylPrice || release.price || item.price;
                  if (part?.name) item.vinylPartName = part.name as string;
                } else {
                  serverPrice = release.vinylPrice || release.price || item.price;
                }

                item.vinylShippingUK = release.vinylShippingUK;
                item.vinylShippingEU = release.vinylShippingEU;
                item.vinylShippingIntl = release.vinylShippingIntl;
                item.vinylShippingAdditional = release.vinylShippingAdditional;

                const artistId = release.artistId || release.userId || item.artistId;
                if (artistId) {
                  item.artistId = artistId;
                  const artist = artistMap.get(artistId);
                  if (artist) {
                    item.artistVinylShippingUK = artist.vinylShippingUK;
                    item.artistVinylShippingEU = artist.vinylShippingEU;
                    item.artistVinylShippingIntl = artist.vinylShippingIntl;
                    item.artistVinylShippingAdditional = artist.vinylShippingAdditional;
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
// Uses Promise.allSettled so one failed download URL fetch doesn't reject all items
export async function processItemsWithDownloads(items: CartItem[]): Promise<CartItem[]> {
  const results = await Promise.allSettled(items.map(async (item: CartItem) => {
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
            // Prefer original quality artwork for downloads (jpg/png), fall back to processed WebP
            const downloadArtworkUrl = releaseData?.originalArtworkUrl || artworkUrl;

            if (track) {
              return {
                ...item,
                releaseId,
                artwork: artworkUrl,
                image: artworkUrl,
                downloads: {
                  artistName,
                  releaseName,
                  artworkUrl: downloadArtworkUrl,
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
                  artworkUrl: downloadArtworkUrl,
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
          // Prefer original quality artwork for downloads (jpg/png), fall back to processed WebP
          const downloadArtworkUrl = releaseData?.originalArtworkUrl || artworkUrl;

          const allTracks = (releaseData?.tracks || []) as Record<string, unknown>[];

          // Multi-part vinyl: buying Part 1 only grants the digital download
          // for the four tracks pressed on Part 1, not the full eight-track
          // release. Filter the tracks array to those whose trackNumber lives
          // in the part's trackNumbers list. Falls through to the full-release
          // download for single-vinyl releases (no vinylParts) and for
          // non-vinyl line items (digital release, etc).
          let downloadTracks = allTracks;
          if (item.type === 'vinyl' && item.vinylPartId) {
            const parts = Array.isArray(releaseData?.vinylParts) ? releaseData.vinylParts as Record<string, unknown>[] : [];
            const part = parts.find((_p, idx) => `part-${idx + 1}` === item.vinylPartId);
            const trackNumbers = part && Array.isArray(part.trackNumbers) ? part.trackNumbers as number[] : null;
            if (trackNumbers && trackNumbers.length > 0) {
              const nums = new Set(trackNumbers.map(n => Number(n)));
              downloadTracks = allTracks.filter((t, idx) => {
                const num = Number(t.displayTrackNumber ?? t.trackNumber ?? (idx + 1));
                return nums.has(num);
              });
            }
          }

          const downloads = {
            artistName,
            releaseName,
            artworkUrl: downloadArtworkUrl,
            tracks: downloadTracks.map((track: Record<string, unknown>) => ({
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

  // Extract fulfilled results; for any rejected items, return the item without downloads
  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    log.error('[order-utils] Download processing failed for item:', items[i]?.name, r.reason);
    return { ...items[i], releaseId: items[i].releaseId || items[i].productId || items[i].id };
  });
}
