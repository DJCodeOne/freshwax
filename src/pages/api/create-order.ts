// src/pages/api/create-order.ts
// Creates order in Firebase and sends confirmation email

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, addDocument, clearCache, atomicIncrement, updateDocumentConditional } from '../../lib/firebase-rest';
import { d1UpsertMerch } from '../../lib/d1-catalog';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { generateOrderNumber } from '../../lib/order-utils';
import { SITE_URL } from '../../lib/constants';
import { formatPrice } from '../../lib/format-utils';
import { fetchWithTimeout, errorResponse, successResponse, ApiErrors, createLogger } from '../../lib/api-utils';
import { buildOrderConfirmationEmail, buildStockistFulfillmentEmail, buildDigitalSaleEmail, buildMerchSaleEmail } from '../../lib/order/create-order-emails';
import type { OrderItem } from '../../lib/order/create-order-emails';

// Zod schemas for order creation
const OrderItemSchema = z.object({
  id: z.string().nullish(),
  productId: z.string().nullish(),
  releaseId: z.string().nullish(),
  trackId: z.string().nullish(),
  name: z.string().min(1, 'Item name required').max(500),
  type: z.string().nullish(),
  price: z.number().positive('Price must be positive'),
  quantity: z.number().int().min(1).max(99).default(1),
  size: z.string().nullish(),
  color: z.string().nullish(),
  image: z.string().nullish(),
  artwork: z.string().nullish(),
  artist: z.string().nullish(),
  artistId: z.string().nullish(),
  artistName: z.string().nullish(),
  artistEmail: z.string().nullish(),
  title: z.string().nullish(),
  isPreOrder: z.boolean().nullish(),
  releaseDate: z.string().nullish(),
  sellerId: z.string().nullish(),
}).strip();

const OrderCustomerSchema = z.object({
  email: z.string().email('Valid email required'),
  firstName: z.string().min(1, 'First name required'),
  lastName: z.string().min(1, 'Last name required'),
  phone: z.string().nullish(),
  userId: z.string().nullish(),
}).strip();

const OrderShippingSchema = z.object({
  address1: z.string().nullish(),
  address2: z.string().nullish(),
  city: z.string().nullish(),
  county: z.string().nullish(),
  postcode: z.string().nullish(),
  country: z.string().nullish(),
}).strip().nullish();

const CreateOrderSchema = z.object({
  customer: OrderCustomerSchema,
  items: z.array(OrderItemSchema).min(1, 'At least one item required').max(50, 'Too many items (max 50)'),
  shipping: OrderShippingSchema,
  hasPhysicalItems: z.boolean().optional(),
  totals: z.object({
    subtotal: z.number().optional(),
    shipping: z.number().optional(),
    total: z.number().positive('Total must be positive'),
  }).strip().optional(),
  paymentMethod: z.string().optional(),
  idToken: z.string().optional(),
}).strip();

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

// Order validation constants
const MAX_ITEMS_PER_ORDER = 50;
const MAX_QUANTITY_PER_ITEM = 99;

// Validate item prices server-side to prevent manipulation
async function validateOrderPrices(items: Record<string, unknown>[]): Promise<{ validatedItems: Record<string, unknown>[], serverSubtotal: number, hasMismatch: boolean, validationError?: string }> {
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

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: strict - 5 orders per minute per IP (prevents order spam)
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`create-order:${clientId}`, RateLimiters.strict);
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  // Initialize Firebase for Cloudflare runtime
  const env = locals.runtime.env;
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
  const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;



  try {
    const rawBody = await request.json();

    // Zod input validation
    const parseResult = CreateOrderSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const orderData = parseResult.data;

    // Extract idToken for authenticated Firebase writes
    const idToken = orderData.idToken;

    // Check shipping for physical items
    if (orderData.hasPhysicalItems && !orderData.shipping?.address1) {
      return ApiErrors.badRequest('Shipping address required for physical items');
    }

    // IMPORTANT: Verify user is a customer (only customers can purchase)
    if (orderData.customer.userId) {
      const [userDoc, artistDoc] = await Promise.all([
        getDocument('users', orderData.customer.userId),
        getDocument('artists', orderData.customer.userId)
      ]);

      const isCustomer = !!userDoc;
      const isArtist = !!artistDoc;

      // If user is an artist but NOT a customer, deny the order
      if (isArtist && !isCustomer) {
        log.info('[create-order] ✗ Denied: Artist account attempting to purchase');
        return ApiErrors.forbidden('Artist accounts cannot make purchases. Please create a separate customer account to buy items.');
      }

      // Log warning if no customer record found but still allow guest checkout
      if (!isCustomer) {
        log.info('[create-order] ⚠️ No customer record found for userId:', orderData.customer.userId);
      } else {
        log.info('[create-order] ✓ Customer verified:', orderData.customer.userId);
      }
    } else {
      // Guest checkout - allowed for non-logged-in users
      log.info('[create-order] Guest checkout for:', orderData.customer.email);
    }

    const orderNumber = generateOrderNumber();
    const now = new Date().toISOString();

    // Server-side price validation - prevent client-side price manipulation
    const { validatedItems: pricedItems, serverSubtotal, hasMismatch, validationError } = await validateOrderPrices(orderData.items);

    if (validationError) {
      return ApiErrors.badRequest(validationError);
    }

    // Server-side shipping calculation — never trust client-submitted shipping
    const hasMerchItems = pricedItems.some((item: OrderItem) => item.type === 'merch');
    const hasVinylItems = pricedItems.some((item: OrderItem) => item.type === 'vinyl');
    const customerCountry = orderData.shipping?.country || 'GB';
    const isUK = customerCountry === 'GB' || customerCountry === 'United Kingdom' || customerCountry === 'UK';
    const euCountries = ['DE', 'FR', 'NL', 'BE', 'IE', 'ES', 'IT', 'AT', 'PL', 'PT', 'DK', 'SE', 'FI', 'CZ', 'GR', 'HU', 'RO', 'BG', 'HR', 'SK', 'SI', 'LT', 'LV', 'EE', 'CY', 'MT', 'LU'];
    const isEU = euCountries.includes(customerCountry);

    let merchShipping = 0;
    let vinylShippingTotal = 0;
    const artistShippingBreakdown: Record<string, { artistId: string; artistName: string; amount: number }> = {};

    if (hasMerchItems) {
      const merchSubtotal = pricedItems
        .filter((item: OrderItem) => item.type === 'merch')
        .reduce((sum: number, item: OrderItem) => sum + (item.price * (item.quantity || 1)), 0);
      merchShipping = merchSubtotal >= 50 ? 0 : 4.99;
    }

    if (hasVinylItems) {
      for (const item of pricedItems) {
        if (item.type !== 'vinyl') continue;
        const artistId = item.artistId;

        if (item.sellerId && !item.releaseId) {
          // Vinyl crates — seller shipping cost
          vinylShippingTotal += item.shippingCost ?? 4.99;
        } else if (artistId) {
          // Per-artist vinyl shipping (one charge per artist)
          if (!artistShippingBreakdown[artistId]) {
            let shippingRate = 0;
            if (isUK) {
              shippingRate = item.serverVinylShippingUK ?? item.serverArtistShippingUK ?? 4.99;
            } else if (isEU) {
              shippingRate = item.serverVinylShippingEU ?? item.serverArtistShippingEU ?? 9.99;
            } else {
              shippingRate = item.serverVinylShippingIntl ?? item.serverArtistShippingIntl ?? 14.99;
            }
            artistShippingBreakdown[artistId] = {
              artistId,
              artistName: item.artist || item.artistName || 'Artist',
              amount: shippingRate
            };
            vinylShippingTotal += shippingRate;
          }
        }
      }
    }

    const serverShipping = Math.round((merchShipping + vinylShippingTotal) * 100) / 100;
    const serverTotal = Math.round((serverSubtotal + serverShipping) * 100) / 100;

    // Reject if client total is significantly lower than server-calculated total
    const clientTotal = orderData.totals?.total || 0;
    if (serverTotal > 0 && clientTotal < serverTotal * 0.95) {
      log.error('[create-order] SECURITY: Client total', clientTotal, 'is below server total', serverTotal, '(subtotal:', serverSubtotal, 'shipping:', serverShipping, ')');
      return ApiErrors.badRequest('Price validation failed. Please refresh and try again.');
    }

    // Get download URLs for digital items
    const itemsWithDownloads = await Promise.all(pricedItems.map(async (item: OrderItem) => {
      // Get the release ID (could be stored as id, productId, or releaseId)
      const releaseId = item.releaseId || item.productId || item.id;

      log.info('[create-order] Processing item:', item.name, 'type:', item.type, 'releaseId:', releaseId);

      // Check if this is a digital release, track, or vinyl
      if (item.type === 'digital' || item.type === 'release' || item.type === 'track' || item.type === 'vinyl' || (!item.type && releaseId)) {
        try {
          // Try to fetch release data for download URLs
          log.info('[create-order] Fetching release from Firebase:', releaseId);
          const releaseData = await getDocument('releases', releaseId);

          if (releaseData) {
            log.info('[create-order] Release found:', releaseData?.releaseName);
            log.info('[create-order] Tracks count:', releaseData?.tracks?.length || 0);
            log.info('[create-order] Artwork fields - coverArtUrl:', releaseData?.coverArtUrl, 'artwork.cover:', releaseData?.artwork?.cover, 'artwork.artworkUrl:', releaseData?.artwork?.artworkUrl);
            log.info('[create-order] Item artwork from cart:', item.artwork, 'Item image from cart:', item.image);

            // If it's a single track purchase, only include that track
            if (item.type === 'track') {
              let track = null;

              // Method 1: Match by trackId
              if (item.trackId) {
                track = (releaseData?.tracks || []).find((t: TrackData) =>
                  t.id === item.trackId ||
                  t.trackId === item.trackId ||
                  String(t.trackNumber) === String(item.trackId)
                );
              }

              // Method 2: Match by track name from item name
              if (!track && item.name) {
                const itemNameParts = item.name.split(' - ');
                const trackNameFromItem = itemNameParts.length > 1 ? itemNameParts.slice(1).join(' - ') : item.name;
                track = (releaseData?.tracks || []).find((t: TrackData) =>
                  (t.trackName || t.name || '').toLowerCase() === trackNameFromItem.toLowerCase()
                );
              }

              // Method 3: Match by title field
              if (!track && item.title) {
                track = (releaseData?.tracks || []).find((t: TrackData) =>
                  (t.trackName || t.name || '').toLowerCase() === item.title.toLowerCase()
                );
              }

              log.info('[create-order] Single track found:', track?.trackName || 'NOT FOUND');

              // Get artist and release name for filename
              const artistName = releaseData?.artistName || item.artist || 'Unknown Artist';
              const releaseName = releaseData?.releaseName || releaseData?.title || item.title || 'Release';

              if (track) {
                // Get artwork from Firebase - prefer original full-res for buyer downloads
                const artworkUrl = releaseData?.originalArtworkUrl || releaseData?.coverArtUrl || releaseData?.artwork?.cover || releaseData?.artwork?.artworkUrl || item.artwork || item.image || null;
                log.info('[create-order] Track artwork URL:', artworkUrl);
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
                const artworkUrl = releaseData?.originalArtworkUrl || releaseData?.coverArtUrl || releaseData?.artwork?.cover || releaseData?.artwork?.artworkUrl || item.artwork || item.image || null;
                log.info('[create-order] Fallback artwork URL:', artworkUrl);
                return {
                  ...item,
                  releaseId,
                  artwork: artworkUrl,
                  image: artworkUrl,
                  downloads: {
                    artistName,
                    releaseName,
                    artworkUrl,
                    tracks: (releaseData?.tracks || []).map((t: TrackData) => ({
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
            // Get artwork from Firebase - prefer original full-res for buyer downloads
            const artworkUrl = releaseData?.originalArtworkUrl || releaseData?.coverArtUrl || releaseData?.artwork?.cover || releaseData?.artwork?.artworkUrl || item.artwork || item.image || null;
            log.info('[create-order] Full release artwork URL:', artworkUrl);

            const downloads = {
              artistName,
              releaseName,
              artworkUrl,
              tracks: (releaseData?.tracks || []).map((track: TrackData) => ({
                name: track.trackName || track.name,
                mp3Url: track.mp3Url || null,
                wavUrl: track.wavUrl || null
              }))
            };
            log.info('[create-order] Downloads prepared:', downloads.tracks.length, 'tracks, artworkUrl:', artworkUrl ? 'YES' : 'NO');

            return {
              ...item,
              releaseId,
              artwork: artworkUrl,
              image: artworkUrl,
              downloads
            };
          } else {
            log.info('[create-order] Release NOT found:', releaseId);
          }
        } catch (e: unknown) {
          log.error('[create-order] Error fetching release:', releaseId, e);
        }
      } else {
        log.info('[create-order] Skipping non-digital item:', item.type);
      }
      return { ...item, releaseId };
    }));

    // Strip download URLs from pending orders - these get added by the webhook when payment is confirmed
    const safeItems = itemsWithDownloads.map((item: OrderItem) => {
      if (item.downloads?.tracks) {
        return {
          ...item,
          downloads: {
            ...item.downloads,
            tracks: item.downloads.tracks.map((track: { name: string; mp3Url?: string | null; wavUrl?: string | null }) => {
              const { mp3Url, wavUrl, ...safeTrack } = track;
              return safeTrack;
            })
          }
        };
      }
      return item;
    });

    // Create order document
    // Check if any items are pre-orders
    const hasPreOrderItems = safeItems.some((item: OrderItem) => item.isPreOrder === true);
    const preOrderReleaseDates = safeItems
      .filter((item: OrderItem) => item.isPreOrder && item.releaseDate)
      .map((item: OrderItem) => new Date(item.releaseDate!));
    const latestPreOrderDate = preOrderReleaseDates.length > 0
      ? new Date(Math.max(...preOrderReleaseDates.map((d: Date) => d.getTime()))).toISOString()
      : null;

    const order = {
      orderNumber,
      customer: {
        email: orderData.customer.email,
        firstName: orderData.customer.firstName,
        lastName: orderData.customer.lastName,
        phone: orderData.customer.phone || '',
        userId: orderData.customer.userId || null
      },
      customerId: orderData.customer.userId || null,  // Top-level for easy querying
      shipping: orderData.shipping || null,
      items: safeItems,
      totals: {
        subtotal: serverSubtotal,
        shipping: serverShipping,
        merchShipping,
        vinylShipping: vinylShippingTotal,
        total: serverTotal,
        ...(hasMismatch ? { clientSubmittedTotal: clientTotal, priceValidated: true } : {}),
        ...(Object.keys(artistShippingBreakdown).length > 0 ? { artistShippingBreakdown } : {})
      },
      hasPhysicalItems: orderData.hasPhysicalItems,
      hasPreOrderItems,
      preOrderDeliveryDate: latestPreOrderDate,
      paymentMethod: orderData.paymentMethod || 'test_mode',
      paymentStatus: 'pending',
      status: hasPreOrderItems ? 'awaiting_release' : 'pending',
      orderStatus: hasPreOrderItems ? 'awaiting_release' : 'pending',
      createdAt: now,
      updatedAt: now
    };

    // Save to Firebase (with idToken for authenticated write)
    const orderRef = await addDocument('orders', order, idToken);

    log.info('[create-order] ✓ Order created:', orderNumber, orderRef.id);

    // Update stock for merch items (with optimistic concurrency to prevent overselling)
    const MAX_STOCK_RETRIES = 3;
    for (const item of order.items) {
      if (item.type === 'merch' && item.productId) {
        try {
          log.info('[create-order] Updating stock for merch item:', item.name, 'qty:', item.quantity);

          let stockUpdated = false;
          let previousStock = 0;
          let newStock = 0;
          let variantKey = '';
          let productData: Record<string, unknown> | null = null;

          for (let attempt = 0; attempt < MAX_STOCK_RETRIES; attempt++) {
            // Clear cache on retry to get fresh data
            if (attempt > 0) {
              clearCache(`doc:merch:${item.productId}`);
              log.info(`[create-order] Stock update retry ${attempt + 1}/${MAX_STOCK_RETRIES} for ${item.name}`);
            }

            productData = await getDocument('merch', item.productId);
            if (!productData) break;

            // Deep clone variantStock to avoid mutating cached data
            const variantStock: Record<string, Record<string, unknown>> = {};
            for (const [k, v] of Object.entries((productData.variantStock as Record<string, Record<string, unknown>>) || {})) {
              variantStock[k] = { ...v };
            }

            // Build variant key from size and color
            const size = (item.size || 'onesize').toLowerCase().replace(/\s/g, '-');
            const color = (item.color || 'default').toLowerCase().replace(/\s/g, '-');
            variantKey = size + '_' + color;

            // Check if variant exists, otherwise try fallback matching
            if (!variantStock[variantKey]) {
              const keys = Object.keys(variantStock);
              if (keys.length === 1) {
                variantKey = keys[0];
              } else if (keys.length > 1) {
                const sizeMatch = keys.find(k => k.startsWith(size + '_'));
                const colorMatch = keys.find(k => k.endsWith('_' + color));
                variantKey = sizeMatch || colorMatch || keys[0];
              }
            }

            const variant = variantStock[variantKey];
            if (!variant) {
              log.info('[create-order] ⚠️ Variant not found:', variantKey, 'for product:', item.productId);
              break;
            }

            previousStock = variant.stock || 0;
            newStock = Math.max(0, previousStock - item.quantity);

            if (previousStock < item.quantity) {
              log.info('[create-order] ⚠️ Insufficient stock:', item.name, variantKey,
                '- Ordered:', item.quantity, '- Available:', previousStock);
              // Allow order but flag it - stock already went negative, alert admin
              // Order was already created above, so we proceed but log the oversell
            }

            variant.stock = newStock;
            variant.sold = (variant.sold || 0) + item.quantity;
            variantStock[variantKey] = variant;

            let totalStock = 0;
            let totalSold = 0;
            Object.values(variantStock).forEach((v: Record<string, unknown>) => {
              totalStock += (v.stock as number) || 0;
              totalSold += (v.sold as number) || 0;
            });

            try {
              // Conditional update - fails if document was modified since we read it
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
                // Fallback to non-conditional update if no updateTime available
                await updateDocument('merch', item.productId, {
                  variantStock: variantStock,
                  totalStock: totalStock,
                  soldStock: totalSold,
                  isLowStock: totalStock <= (productData.lowStockThreshold || 5) && totalStock > 0,
                  isOutOfStock: totalStock === 0,
                  updatedAt: now
                });
              }
              stockUpdated = true;
              log.info('[create-order] ✓ Stock updated:', item.name, variantKey, previousStock, '->', newStock);
              break; // Success - exit retry loop
            } catch (conflictErr: unknown) {
              const conflictMessage = conflictErr instanceof Error ? conflictErr.message : String(conflictErr);
              if (conflictMessage?.includes('CONFLICT') && attempt < MAX_STOCK_RETRIES - 1) {
                log.info(`[create-order] Stock conflict for ${item.name}, retrying...`);
                continue;
              }
              throw conflictErr;
            }
          }

          // Only record stock movement and do post-update work if stock was actually updated
          if (stockUpdated && productData) {
            // Record stock movement
            await addDocument('merch-stock-movements', {
              productId: item.productId,
              productName: item.name,
              sku: productData.sku,
              variantKey: variantKey,
              variantSku: productData.variantStock?.[variantKey]?.sku,
              type: 'sell',
              quantity: item.quantity,
              stockDelta: -item.quantity,
              previousStock: previousStock,
              newStock: newStock,
              orderId: orderRef.id,
              orderNumber: orderNumber,
              notes: 'Order ' + orderNumber,
              createdAt: now,
              createdBy: 'system'
            }, idToken);

            // Sync to D1 so public merch page shows updated stock
            const db = env?.DB;
            if (db) {
              try {
                clearCache(`doc:merch:${item.productId}`);
                const updatedProduct = await getDocument('merch', item.productId);
                if (updatedProduct) {
                  await d1UpsertMerch(db, item.productId, updatedProduct);
                  log.info('[create-order] ✓ D1 synced for:', item.name);
                }
              } catch (d1Error: unknown) {
                log.error('[create-order] D1 sync failed (non-critical):', d1Error);
              }
            }

            // Update supplier stats atomically and get seller email for notifications
            if (productData.supplierId) {
              try {
                const supplierRevenue = (productData.retailPrice || item.price) * item.quantity * ((productData.supplierCut || 0) / 100);

                // Use atomic increment for supplier counters to prevent race conditions
                await atomicIncrement('merch-suppliers', productData.supplierId, {
                  totalStock: -item.quantity,
                  totalSold: item.quantity,
                  totalRevenue: supplierRevenue,
                });
                await updateDocument('merch-suppliers', productData.supplierId, { updatedAt: now });
                log.info('[create-order] ✓ Supplier stats updated (atomic)');

                // Fetch supplier data for email (read-only, no race concern)
                const supplierData = await getDocument('merch-suppliers', productData.supplierId);
                if (supplierData?.email) {
                  item.sellerEmail = supplierData.email;
                  item.supplierId = productData.supplierId;
                  log.info('[create-order] ✓ Attached seller email from merch-suppliers:', supplierData.email);
                }

                // If no email yet, try users collection
                if (!item.sellerEmail) {
                  const userData = await getDocument('users', productData.supplierId);
                  if (userData?.email) {
                    item.sellerEmail = userData.email;
                    item.supplierId = productData.supplierId;
                    log.info('[create-order] ✓ Attached seller email from users:', userData.email);
                  }
                }

                // If still no email, try artists collection
                if (!item.sellerEmail) {
                  const artistData = await getDocument('artists', productData.supplierId);
                  if (artistData?.email) {
                    item.sellerEmail = artistData.email;
                    item.supplierId = productData.supplierId;
                    log.info('[create-order] ✓ Attached seller email from artists:', artistData.email);
                  }
                }
              } catch (supplierErr: unknown) {
                log.info('[create-order] Could not update supplier stats:', supplierErr);
              }
            }

            // Also attach supplierId/sellerId to item for sales ledger
            if (productData.supplierId && !item.supplierId) {
              item.supplierId = productData.supplierId;
              item.sellerId = productData.supplierId;
            }
            if (productData.sellerId && !item.sellerId) {
              item.sellerId = productData.sellerId;
            }
          } else if (!productData) {
            log.info('[create-order] ⚠️ Product not found for stock update:', item.productId);
          }
        } catch (stockErr: unknown) {
          // Log but don't fail the order
          log.error('[create-order] Stock update error:', stockErr);
        }
      }
    }

    // Log item artwork data for debugging
    for (const item of order.items) {
      log.info('[create-order] Item for email:', item.name, '| artwork:', item.artwork, '| image:', item.image, '| downloads.artworkUrl:', item.downloads?.artworkUrl);
    }

    // Send confirmation email directly
    try {
      const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

      if (RESEND_API_KEY && order.customer?.email) {
        log.info('[create-order] Sending email to:', order.customer.email);

        // Extract short order number for customer display (e.g., "FW-ABC123" from "FW-241204-abc123")
        const orderParts = orderNumber.split('-');
        const shortOrderNumber = orderParts.length >= 3
          ? (orderParts[0] + '-' + orderParts[orderParts.length - 1]).toUpperCase()
          : orderNumber.toUpperCase();

        const emailHtml = buildOrderConfirmationEmail(orderRef.id, shortOrderNumber, order);

        const emailResponse = await fetchWithTimeout('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + RESEND_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Fresh Wax <orders@freshwax.co.uk>',
            to: [order.customer.email],
            bcc: ['freshwaxonline@gmail.com'],
            subject: 'Order Confirmed - ' + shortOrderNumber,
            html: emailHtml
          })
        }, 10000);

        if (emailResponse.ok) {
          const emailResult = await emailResponse.json();
          log.info('[create-order] ✓ Email sent! ID:', emailResult.id);
        } else {
          const error = await emailResponse.text();
          log.error('[create-order] ❌ Email failed:', error);
        }
      } else {
        log.info('[create-order] Skipping email - no API key or no customer email');
      }
    } catch (emailError: unknown) {
      log.error('[create-order] Email error:', emailError);
      // Don't fail the order if email fails
    }

    // Send fulfillment email to stockist/label for vinyl orders
    const vinylItems = order.items.filter((item: OrderItem) => item.type === 'vinyl');
    if (vinylItems.length > 0) {
      try {
        const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
        const STOCKIST_EMAIL = env?.VINYL_STOCKIST_EMAIL || import.meta.env.VINYL_STOCKIST_EMAIL || 'stockist@freshwax.co.uk';

        if (RESEND_API_KEY && STOCKIST_EMAIL) {
          log.info('[create-order] Sending vinyl fulfillment email to stockist:', STOCKIST_EMAIL);

          const fulfillmentHtml = buildStockistFulfillmentEmail(orderRef.id, orderNumber, order, vinylItems);

          const fulfillmentResponse = await fetchWithTimeout('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + RESEND_API_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: 'Fresh Wax Orders <orders@freshwax.co.uk>',
              to: [STOCKIST_EMAIL],
              bcc: ['freshwaxonline@gmail.com'],
              subject: '📦 VINYL FULFILLMENT REQUIRED - ' + orderNumber,
              html: fulfillmentHtml
            })
          }, 10000);

          if (fulfillmentResponse.ok) {
            const result = await fulfillmentResponse.json();
            log.info('[create-order] ✓ Stockist email sent! ID:', result.id);
          } else {
            const error = await fulfillmentResponse.text();
            log.error('[create-order] ❌ Stockist email failed:', error);
          }
        }
      } catch (stockistError: unknown) {
        log.error('[create-order] Stockist email error:', stockistError);
        // Don't fail the order if stockist email fails
      }

      // Mark vinyl crates listings as sold (single-item listings from marketplace sellers)
      for (const vItem of vinylItems) {
        if (vItem.sellerId && !vItem.releaseId) {
          const listingId = vItem.id || vItem.productId;
          if (listingId) {
            try {
              await updateDocument('vinylListings', listingId, {
                status: 'sold',
                soldAt: new Date().toISOString(),
                orderId: orderRef.id,
                orderNumber
              });
              log.info('[create-order] Marked vinyl listing as sold:', listingId);
            } catch (vinylErr: unknown) {
              log.error('[create-order] Failed to mark vinyl as sold:', listingId, vinylErr);
            }
          }
        }
      }
    }

    // Send notification emails to artists for digital sales (tracks/releases)
    const digitalItems = order.items.filter((item: OrderItem) => item.type === 'track' || item.type === 'digital' || item.type === 'release');
    if (digitalItems.length > 0) {
      try {
        const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

        // Group items by artist email
        const itemsByArtist: { [email: string]: OrderItem[] } = {};
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
          if (RESEND_API_KEY && artistEmail) {
            log.info('[create-order] Sending digital sale email to artist:', artistEmail);

            const digitalHtml = buildDigitalSaleEmail(orderNumber, order, items);

            const digitalResponse = await fetchWithTimeout('https://api.resend.com/emails', {
              method: 'POST',
              headers: {
                'Authorization': 'Bearer ' + RESEND_API_KEY,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                from: 'Fresh Wax <orders@freshwax.co.uk>',
                to: [artistEmail],
                bcc: ['freshwaxonline@gmail.com'],
                subject: '🎵 Digital Sale! ' + orderNumber,
                html: digitalHtml
              })
            }, 10000);

            if (digitalResponse.ok) {
              log.info('[create-order] ✓ Digital sale email sent to:', artistEmail);
            } else {
              const error = await digitalResponse.text();
              log.error('[create-order] ❌ Digital sale email failed:', error);
            }
          }
        }
      } catch (digitalError: unknown) {
        log.error('[create-order] Digital sale email error:', digitalError);
      }
    }

    // Send notification emails to merch sellers
    const merchItems = order.items.filter((item: OrderItem) => item.type === 'merch');
    if (merchItems.length > 0) {
      try {
        const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

        // Group items by seller email (use stockistEmail or artistEmail)
        const itemsBySeller: { [email: string]: OrderItem[] } = {};
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
          if (RESEND_API_KEY && sellerEmail) {
            log.info('[create-order] Sending merch sale email to seller:', sellerEmail);

            const merchHtml = buildMerchSaleEmail(orderNumber, order, items);

            const merchResponse = await fetchWithTimeout('https://api.resend.com/emails', {
              method: 'POST',
              headers: {
                'Authorization': 'Bearer ' + RESEND_API_KEY,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                from: 'Fresh Wax Orders <orders@freshwax.co.uk>',
                to: [sellerEmail],
                bcc: ['freshwaxonline@gmail.com'],
                subject: '👕 Merch Order! ' + orderNumber,
                html: merchHtml
              })
            }, 10000);

            if (merchResponse.ok) {
              log.info('[create-order] ✓ Merch sale email sent to:', sellerEmail);
            } else {
              const error = await merchResponse.text();
              log.error('[create-order] ❌ Merch sale email failed:', error);
            }
          }
        }
      } catch (merchError: unknown) {
        log.error('[create-order] Merch sale email error:', merchError);
      }
    }

    // Update customer's order count atomically if they have an account
    if (orderData.customer.userId) {
      try {
        await atomicIncrement('users', orderData.customer.userId, { orderCount: 1 });
        await updateDocument('users', orderData.customer.userId, { lastOrderAt: now });
      } catch (e: unknown) {
        log.error('[create-order] Error updating customer:', e);
      }
    }

    return successResponse({ orderId: orderRef.id,
      orderNumber });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : '';
    log.error('[create-order] Error:', errorMessage);
    log.error('[create-order] Stack:', errorStack);
    // SECURITY: Don't expose internal error details to client
    return ApiErrors.serverError('Failed to create order. Please try again or contact support.');
  }
};
