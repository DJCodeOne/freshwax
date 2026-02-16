// src/pages/api/create-order.ts
// Creates order in Firebase and sends confirmation email

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, addDocument, clearCache, atomicIncrement, updateDocumentConditional } from '../../lib/firebase-rest';
import { d1UpsertMerch } from '../../lib/d1-catalog';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { generateOrderNumber } from '../../lib/order-utils';
import { SITE_URL } from '../../lib/constants';
import { fetchWithTimeout, errorResponse, ApiErrors } from '../../lib/api-utils';

// Zod schemas for order creation
const OrderItemSchema = z.object({
  id: z.string().optional(),
  productId: z.string().optional(),
  releaseId: z.string().optional(),
  trackId: z.string().optional(),
  name: z.string().min(1, 'Item name required').max(500),
  type: z.enum(['digital', 'track', 'release', 'vinyl', 'merch']).optional(),
  price: z.number().positive('Price must be positive'),
  quantity: z.number().int().min(1).max(99).default(1),
  size: z.string().optional(),
  color: z.string().optional(),
  image: z.string().optional(),
  artwork: z.string().optional(),
  artist: z.string().optional(),
  artistId: z.string().optional(),
  artistName: z.string().optional(),
  artistEmail: z.string().optional(),
  title: z.string().optional(),
  isPreOrder: z.boolean().optional(),
  releaseDate: z.string().optional(),
  sellerId: z.string().optional(),
}).passthrough();

const OrderCustomerSchema = z.object({
  email: z.string().email('Valid email required'),
  firstName: z.string().min(1, 'First name required'),
  lastName: z.string().min(1, 'Last name required'),
  phone: z.string().optional(),
  userId: z.string().optional(),
}).passthrough();

const OrderShippingSchema = z.object({
  address1: z.string().optional(),
  address2: z.string().optional(),
  city: z.string().optional(),
  county: z.string().optional(),
  postcode: z.string().optional(),
  country: z.string().optional(),
}).passthrough().optional().nullable();

const CreateOrderSchema = z.object({
  customer: OrderCustomerSchema,
  items: z.array(OrderItemSchema).min(1, 'At least one item required').max(50, 'Too many items (max 50)'),
  shipping: OrderShippingSchema,
  hasPhysicalItems: z.boolean().optional(),
  totals: z.object({
    subtotal: z.number().optional(),
    shipping: z.number().optional(),
    total: z.number().positive('Total must be positive'),
  }).passthrough().optional(),
  paymentMethod: z.string().optional(),
  idToken: z.string().optional(),
}).passthrough();

// Conditional logging - only logs in development
const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

// Order validation constants
const MAX_ITEMS_PER_ORDER = 50;
const MAX_QUANTITY_PER_ITEM = 99;

// Escape user-supplied data for safe HTML embedding in emails
function escHtml(str: string | null | undefined): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// Validate item prices server-side to prevent manipulation
async function validateOrderPrices(items: any[]): Promise<{ validatedItems: any[], serverSubtotal: number, hasMismatch: boolean, validationError?: string }> {
  const validatedItems: any[] = [];
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

  const [merchDocs, releaseDocs, listingDocs] = await Promise.all([
    Promise.all(uniqueMerchIds.map(id => getDocument('merch', id))),
    Promise.all(uniqueReleaseIds.map(id => getDocument('releases', id))),
    Promise.all(uniqueListingIds.map(id => getDocument('vinylListings', id)))
  ]);

  // Build lookup maps
  const merchMap = new Map(uniqueMerchIds.map((id, i) => [id, merchDocs[i]]));
  const releaseMap = new Map(uniqueReleaseIds.map((id, i) => [id, releaseDocs[i]]));
  const listingMap = new Map(uniqueListingIds.map((id, i) => [id, listingDocs[i]]));

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
  const artistDocs = await Promise.all(uniqueArtistIds.map(id => getDocument('artists', id)));
  const artistMap = new Map(uniqueArtistIds.map((id, i) => [id, artistDocs[i]]));

  for (const item of items) {
    let serverPrice = item.price;
    const itemType = item.type || 'digital';
    const quantity = item.quantity || 1;
    const extraFields: Record<string, any> = {};

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
          const track = (release.tracks || []).find((t: any) =>
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
        console.warn('[create-order] SECURITY: Price mismatch for', item.name, '- Client:', item.price, 'Server:', serverPrice);
        hasMismatch = true;
      }

      serverSubtotal += serverPrice * quantity;
      validatedItems.push({ ...item, price: serverPrice, originalClientPrice: item.price, ...extraFields });
    } catch (err) {
      console.error('[create-order] Error validating price for', item.name, err);
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
    const hasMerchItems = pricedItems.some((item: any) => item.type === 'merch');
    const hasVinylItems = pricedItems.some((item: any) => item.type === 'vinyl');
    const customerCountry = orderData.shipping?.country || 'GB';
    const isUK = customerCountry === 'GB' || customerCountry === 'United Kingdom' || customerCountry === 'UK';
    const euCountries = ['DE', 'FR', 'NL', 'BE', 'IE', 'ES', 'IT', 'AT', 'PL', 'PT', 'DK', 'SE', 'FI', 'CZ', 'GR', 'HU', 'RO', 'BG', 'HR', 'SK', 'SI', 'LT', 'LV', 'EE', 'CY', 'MT', 'LU'];
    const isEU = euCountries.includes(customerCountry);

    let merchShipping = 0;
    let vinylShippingTotal = 0;
    const artistShippingBreakdown: Record<string, { artistId: string; artistName: string; amount: number }> = {};

    if (hasMerchItems) {
      const merchSubtotal = pricedItems
        .filter((item: any) => item.type === 'merch')
        .reduce((sum: number, item: any) => sum + (item.price * (item.quantity || 1)), 0);
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
      console.error('[create-order] SECURITY: Client total', clientTotal, 'is below server total', serverTotal, '(subtotal:', serverSubtotal, 'shipping:', serverShipping, ')');
      return ApiErrors.badRequest('Price validation failed. Please refresh and try again.');
    }

    // Get download URLs for digital items
    const itemsWithDownloads = await Promise.all(pricedItems.map(async (item: any) => {
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
                track = (releaseData?.tracks || []).find((t: any) =>
                  t.id === item.trackId ||
                  t.trackId === item.trackId ||
                  String(t.trackNumber) === String(item.trackId)
                );
              }

              // Method 2: Match by track name from item name
              if (!track && item.name) {
                const itemNameParts = item.name.split(' - ');
                const trackNameFromItem = itemNameParts.length > 1 ? itemNameParts.slice(1).join(' - ') : item.name;
                track = (releaseData?.tracks || []).find((t: any) =>
                  (t.trackName || t.name || '').toLowerCase() === trackNameFromItem.toLowerCase()
                );
              }

              // Method 3: Match by title field
              if (!track && item.title) {
                track = (releaseData?.tracks || []).find((t: any) =>
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
                    tracks: (releaseData?.tracks || []).map((t: any) => ({
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
              tracks: (releaseData?.tracks || []).map((track: any) => ({
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
        } catch (e) {
          console.error('[create-order] Error fetching release:', releaseId, e);
        }
      } else {
        log.info('[create-order] Skipping non-digital item:', item.type);
      }
      return { ...item, releaseId };
    }));

    // Strip download URLs from pending orders - these get added by the webhook when payment is confirmed
    const safeItems = itemsWithDownloads.map((item: any) => {
      if (item.downloads?.tracks) {
        return {
          ...item,
          downloads: {
            ...item.downloads,
            tracks: item.downloads.tracks.map((track: any) => {
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
    const hasPreOrderItems = safeItems.some((item: any) => item.isPreOrder === true);
    const preOrderReleaseDates = safeItems
      .filter((item: any) => item.isPreOrder && item.releaseDate)
      .map((item: any) => new Date(item.releaseDate));
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
          let productData: any = null;

          for (let attempt = 0; attempt < MAX_STOCK_RETRIES; attempt++) {
            // Clear cache on retry to get fresh data
            if (attempt > 0) {
              clearCache(`doc:merch:${item.productId}`);
              log.info(`[create-order] Stock update retry ${attempt + 1}/${MAX_STOCK_RETRIES} for ${item.name}`);
            }

            productData = await getDocument('merch', item.productId);
            if (!productData) break;

            // Deep clone variantStock to avoid mutating cached data
            const variantStock: Record<string, any> = {};
            for (const [k, v] of Object.entries(productData.variantStock || {})) {
              variantStock[k] = { ...(v as any) };
            }

            // Build variant key from size and color
            const size = (item.size || 'onesize').toLowerCase().replace(/\s/g, '-');
            const color = (item.color || 'default').toLowerCase().replace(/\s/g, '-');
            variantKey = size + '_' + color;

            // Check if variant exists, otherwise try default
            if (!variantStock[variantKey]) {
              const keys = Object.keys(variantStock);
              if (keys.length === 1) {
                variantKey = keys[0];
              } else {
                const sizeMatch = keys.find(k => k.startsWith(size + '_'));
                if (sizeMatch) variantKey = sizeMatch;
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
            Object.values(variantStock).forEach((v: any) => {
              totalStock += v.stock || 0;
              totalSold += v.sold || 0;
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
              } catch (d1Error) {
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
              } catch (supplierErr) {
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
        } catch (stockErr) {
          // Log but don't fail the order
          console.error('[create-order] Stock update error:', stockErr);
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
          console.error('[create-order] ❌ Email failed:', error);
        }
      } else {
        log.info('[create-order] Skipping email - no API key or no customer email');
      }
    } catch (emailError) {
      console.error('[create-order] Email error:', emailError);
      // Don't fail the order if email fails
    }

    // Send fulfillment email to stockist/label for vinyl orders
    const vinylItems = order.items.filter((item: any) => item.type === 'vinyl');
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
            console.error('[create-order] ❌ Stockist email failed:', error);
          }
        }
      } catch (stockistError) {
        console.error('[create-order] Stockist email error:', stockistError);
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
            } catch (vinylErr) {
              console.error('[create-order] Failed to mark vinyl as sold:', listingId, vinylErr);
            }
          }
        }
      }
    }

    // Send notification emails to artists for digital sales (tracks/releases)
    const digitalItems = order.items.filter((item: any) => item.type === 'track' || item.type === 'digital' || item.type === 'release');
    if (digitalItems.length > 0) {
      try {
        const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

        // Group items by artist email
        const itemsByArtist: { [email: string]: any[] } = {};
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
              console.error('[create-order] ❌ Digital sale email failed:', error);
            }
          }
        }
      } catch (digitalError) {
        console.error('[create-order] Digital sale email error:', digitalError);
      }
    }

    // Send notification emails to merch sellers
    const merchItems = order.items.filter((item: any) => item.type === 'merch');
    if (merchItems.length > 0) {
      try {
        const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

        // Group items by seller email (use stockistEmail or artistEmail)
        const itemsBySeller: { [email: string]: any[] } = {};
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
              console.error('[create-order] ❌ Merch sale email failed:', error);
            }
          }
        }
      } catch (merchError) {
        console.error('[create-order] Merch sale email error:', merchError);
      }
    }

    // Update customer's order count atomically if they have an account
    if (orderData.customer.userId) {
      try {
        await atomicIncrement('users', orderData.customer.userId, { orderCount: 1 });
        await updateDocument('users', orderData.customer.userId, { lastOrderAt: now });
      } catch (e) {
        console.error('[create-order] Error updating customer:', e);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      orderId: orderRef.id,
      orderNumber
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : '';
    console.error('[create-order] Error:', errorMessage);
    console.error('[create-order] Stack:', errorStack);
    // SECURITY: Don't expose internal error details to client
    return ApiErrors.serverError('Failed to create order. Please try again or contact support.');
  }
};

// Email template function - Light theme
function buildOrderConfirmationEmail(orderId: string, orderNumber: string, order: any): string {
  const confirmationUrl = `${SITE_URL}/order-confirmation/${orderId}`;

  // Build items HTML - only show image for merch items
  let itemsHtml = '';
  for (const item of order.items) {
    // Check if this is a merch item (only merch gets images)
    const isMerchItem = item.type === 'merch';

    // Only use image for merch
    const itemImage = isMerchItem ? (item.image || item.artwork || '') : '';

    // Format the item type for display
    let typeLabel = '';
    if (item.type === 'digital') typeLabel = 'Digital Download';
    else if (item.type === 'track') typeLabel = 'Single Track';
    else if (item.type === 'vinyl') typeLabel = 'Vinyl Record';
    else if (item.type === 'merch') typeLabel = 'Merchandise';
    else typeLabel = escHtml(item.type) || '';

    // Only show image column for merch - centered
    const imageHtml = itemImage ? '<img src="' + escHtml(itemImage) + '" alt="' + escHtml(item.name) + '" width="70" height="70" style="border-radius: 8px; display: block; margin: 0 auto;">' : '';

    itemsHtml += '<tr><td style="padding: 16px 0; border-bottom: 1px solid #e5e7eb;">' +
      '<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
      (itemImage ? '<td width="86" style="padding-right: 16px; vertical-align: middle; text-align: center;">' + imageHtml + '</td>' : '') +
      '<td style="vertical-align: middle; text-align: left;">' +
      '<div style="font-weight: 600; color: #111; font-size: 15px; margin-bottom: 4px; text-align: left;">' + escHtml(item.name) + '</div>' +
      '<div style="font-size: 13px; color: #6b7280; text-align: left;">' +
      typeLabel +
      (item.size ? ' &bull; Size: ' + escHtml(item.size) : '') +
      (item.color ? ' &bull; ' + escHtml(item.color) : '') +
      (item.quantity > 1 ? ' &bull; Qty: ' + item.quantity : '') +
      '</div></td>' +
      '<td width="80" style="text-align: right; font-weight: 600; color: #111; vertical-align: middle;">&pound;' + (item.price * item.quantity).toFixed(2) + '</td>' +
      '</tr></table></td></tr>';
  }

  // Shipping section
  const shippingSection = order.shipping ?
    '<tr><td style="padding: 20px 24px; background: #f9fafb; border-radius: 8px; margin-top: 16px;">' +
    '<div style="font-weight: 700; color: #111; margin-bottom: 10px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">Shipping To</div>' +
    '<div style="color: #374151; line-height: 1.6; font-size: 14px;">' +
    escHtml(order.customer.firstName) + ' ' + escHtml(order.customer.lastName) + '<br>' +
    escHtml(order.shipping.address1) + '<br>' +
    (order.shipping.address2 ? escHtml(order.shipping.address2) + '<br>' : '') +
    escHtml(order.shipping.city) + ', ' + escHtml(order.shipping.postcode) + '<br>' +
    (order.shipping.county ? escHtml(order.shipping.county) + '<br>' : '') +
    escHtml(order.shipping.country) +
    '</div></td></tr><tr><td style="height: 16px;"></td></tr>' : '';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Order Confirmation</title></head>' +
    '<body style="margin: 0; padding: 0; background: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #f3f4f6;"><tr><td align="center" style="padding: 40px 20px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px;">' +

    // Header with logo and brand - BLACK background
    '<tr><td style="background: #000000; padding: 32px 24px; border-radius: 12px 12px 0 0; text-align: center;">' +
    `<img src="${SITE_URL}/logo.webp" alt="Fresh Wax" width="60" height="60" style="display: block; margin: 0 auto 12px; border-radius: 8px;">` +
    '<div style="font-size: 28px; font-weight: 800; letter-spacing: 1px;"><span style="color: #ffffff;">FRESH</span> <span style="color: #dc2626;">WAX</span></div>' +
    '<div style="font-size: 12px; color: #9ca3af; margin-top: 4px; letter-spacing: 2px;">JUNGLE • DRUM AND BASS</div>' +
    '</td></tr>' +

    // Main content card
    '<tr><td style="background: #ffffff; padding: 32px 24px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +

    // Success message
    '<tr><td align="center" style="padding-bottom: 24px;">' +
    '<div style="width: 56px; height: 56px; background: #dcfce7; border-radius: 50%; margin: 0 auto 16px; line-height: 56px; text-align: center;">' +
    '<span style="color: #16a34a; font-size: 28px;">✓</span></div>' +
    '<h1 style="margin: 0; color: #111; font-size: 24px; font-weight: 700;">Order Confirmed!</h1>' +
    '<p style="margin: 8px 0 0; color: #6b7280; font-size: 14px;">Thank you for your purchase</p>' +
    '</td></tr>' +

    // Order number
    '<tr><td align="center" style="padding-bottom: 24px;">' +
    '<div style="display: inline-block; background: #f3f4f6; padding: 12px 24px; border-radius: 8px;">' +
    '<div style="color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Order Number</div>' +
    '<div style="color: #dc2626; font-size: 18px; font-weight: 700; margin-top: 4px;">' + orderNumber + '</div>' +
    '</div></td></tr>' +

    // Divider
    '<tr><td style="border-top: 1px solid #e5e7eb; padding-top: 24px;"></td></tr>' +

    // Items header - green with dividing line
    '<tr><td style="padding-bottom: 12px; border-bottom: 1px solid #e5e7eb;">' +
    '<div style="font-weight: 700; color: #16a34a; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">Order Details</div>' +
    '</td></tr>' +

    // Items list
    '<tr><td><table cellpadding="0" cellspacing="0" border="0" width="100%">' + itemsHtml + '</table></td></tr>' +

    // Totals - red dividing line above
    '<tr><td style="padding-top: 16px; border-top: 2px solid #dc2626;"><table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="color: #6b7280; padding: 8px 0; font-size: 14px;">Subtotal</td><td style="color: #111; text-align: right; padding: 8px 0; font-size: 14px;">£' + order.totals.subtotal.toFixed(2) + '</td></tr>' +
    '<tr><td style="color: #6b7280; padding: 8px 0; font-size: 14px;">Shipping</td><td style="color: #111; text-align: right; padding: 8px 0; font-size: 14px;">' +
    (order.hasPhysicalItems ? (order.totals.shipping === 0 ? 'FREE' : '£' + order.totals.shipping.toFixed(2)) : 'Digital delivery') + '</td></tr>' +
    (order.totals.serviceFees ? '<tr><td style="color: #9ca3af; padding: 8px 0; font-size: 13px;">Service Fee</td><td style="color: #9ca3af; text-align: right; padding: 8px 0; font-size: 13px;">£' + order.totals.serviceFees.toFixed(2) + '</td></tr>' : '') +
    '<tr><td colspan="2" style="border-top: 2px solid #dc2626; padding-top: 12px;"></td></tr>' +
    '<tr><td style="color: #111; font-weight: 700; font-size: 16px; padding: 4px 0;">Total</td>' +
    '<td style="color: #dc2626; font-weight: 700; font-size: 20px; text-align: right; padding: 4px 0;">£' + order.totals.total.toFixed(2) + '</td></tr>' +
    '</table></td></tr>' +

    // Spacing
    '<tr><td style="height: 24px;"></td></tr>' +

    // Shipping address (if applicable)
    shippingSection +

    // Go back to store button
    '<tr><td align="center" style="padding: 24px 0 8px;">' +
    `<a href="${SITE_URL}" style="display: inline-block; padding: 14px 32px; background: #000000; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">Go Back to Store</a>` +
    '</td></tr>' +

    '</table></td></tr>' +

    // Footer
    '<tr><td align="center" style="padding: 24px 0;">' +
    '<div style="color: #6b7280; font-size: 13px; line-height: 1.6;">Question? Email us at <a href="mailto:contact@freshwax.co.uk" style="color: #111; text-decoration: underline;">contact@freshwax.co.uk</a></div>' +
    `<div style="margin-top: 12px;"><a href="${SITE_URL}" style="color: #9ca3af; font-size: 12px; text-decoration: none;">freshwax.co.uk</a></div>` +
    '</td></tr>' +

    '</table></td></tr></table></body></html>';
}

// Stockist/Label fulfillment email - sent when vinyl is ordered
function buildStockistFulfillmentEmail(orderId: string, orderNumber: string, order: any, vinylItems: any[]): string {
  const orderDate = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  // Build vinyl items table
  let itemsHtml = '';
  for (const item of vinylItems) {
    itemsHtml += '<tr>' +
      '<td style="padding: 12px; border-bottom: 1px solid #e5e7eb; font-weight: 600;">' + escHtml(item.name) + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">' + (item.quantity || 1) + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">&pound;' + (item.price * (item.quantity || 1)).toFixed(2) + '</td>' +
      '</tr>';
  }

  // Calculate vinyl total
  const vinylTotal = vinylItems.reduce((sum: number, item: any) => sum + (item.price * (item.quantity || 1)), 0);

  // Payment status display
  const isTestMode = order.paymentMethod === 'test_mode';
  const paymentStatusColor = order.paymentStatus === 'completed' ? '#16a34a' : '#f59e0b';
  const paymentStatusText = order.paymentStatus === 'completed' ? 'PAID' : 'PENDING';
  const paymentMethodText = isTestMode ? 'Test Mode' : (order.paymentMethod === 'stripe' ? 'Stripe' : order.paymentMethod || 'Card');

  // Payment breakdown - fees are added on top, so artist gets their full asking price (subtotal)
  const artistPayment = order.totals.subtotal; // Artist gets their asking price
  const stripeFee = order.totals.stripeFee || 0;
  const freshWaxFee = order.totals.freshWaxFee || 0;
  const customerPaid = order.totals.total;

  // Payment confirmation section with breakdown
  const paymentSection = '<tr><td style="padding-bottom: 24px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: ' + (order.paymentStatus === 'completed' ? '#dcfce7' : '#fef3c7') + '; border: 2px solid ' + paymentStatusColor + '; border-radius: 8px;">' +
    '<tr><td style="padding: 16px;">' +
    '<div style="font-weight: 700; font-size: 12px; color: ' + paymentStatusColor + '; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">💳 Payment Confirmation</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding: 4px 0; color: #666; font-size: 13px;">Status:</td><td style="padding: 4px 0; font-weight: 700; color: ' + paymentStatusColor + '; font-size: 13px;">' + paymentStatusText + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #666; font-size: 13px;">Method:</td><td style="padding: 4px 0; font-weight: 600; color: #111; font-size: 13px;">' + paymentMethodText + '</td></tr>' +
    (order.stripePaymentId ? '<tr><td style="padding: 4px 0; color: #666; font-size: 13px;">Transaction ID:</td><td style="padding: 4px 0; font-family: monospace; color: #111; font-size: 12px;">' + order.stripePaymentId + '</td></tr>' : '') +
    '</table>' +

    // Payment breakdown - shows that artist gets their full asking price
    '<div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid ' + paymentStatusColor + ';">' +
    '<div style="font-weight: 700; font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Payment Breakdown</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding: 4px 0; color: #111; font-size: 14px; font-weight: 700;">Your Payment:</td><td style="padding: 4px 0; text-align: right; color: #16a34a; font-size: 14px; font-weight: 700;">£' + artistPayment.toFixed(2) + '</td></tr>' +
    '<tr><td colspan="2" style="padding: 4px 0 4px 0; border-top: 1px dashed #ccc;"></td></tr>' +
    '<tr><td style="padding: 4px 0; color: #9ca3af; font-size: 12px;">Stripe Fee (paid by customer):</td><td style="padding: 4px 0; text-align: right; color: #9ca3af; font-size: 12px;">£' + stripeFee.toFixed(2) + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #9ca3af; font-size: 12px;">Fresh Wax 1% (paid by customer):</td><td style="padding: 4px 0; text-align: right; color: #9ca3af; font-size: 12px;">£' + freshWaxFee.toFixed(2) + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #666; font-size: 13px;">Customer Paid:</td><td style="padding: 4px 0; text-align: right; color: #111; font-size: 13px;">£' + customerPaid.toFixed(2) + '</td></tr>' +
    '</table></div>' +

    (isTestMode ? '<div style="margin-top: 12px; padding: 8px; background: #fef3c7; border-radius: 4px; font-size: 12px; color: #92400e;">⚠️ This is a test order - no real payment was processed</div>' : '') +
    '</td></tr></table>' +
    '</td></tr>';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>' +
    '<body style="margin: 0; padding: 0; background: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #f3f4f6;"><tr><td align="center" style="padding: 40px 20px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px;">' +

    // Header - urgent red
    '<tr><td style="background: #dc2626; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">' +
    '<div style="font-size: 24px; font-weight: 800; color: #fff; letter-spacing: 1px;">📦 VINYL FULFILLMENT REQUIRED</div>' +
    '<div style="font-size: 14px; color: rgba(255,255,255,0.9); margin-top: 8px;">Fresh Wax Order</div>' +
    '</td></tr>' +

    // Main content
    '<tr><td style="background: #ffffff; padding: 32px; border-radius: 0 0 12px 12px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +

    // Payment confirmation - NEW SECTION
    paymentSection +

    // Order info box
    '<tr><td style="padding-bottom: 24px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #fef2f2; border: 2px solid #dc2626; border-radius: 8px;">' +
    '<tr><td style="padding: 16px;">' +
    '<div style="font-weight: 700; font-size: 12px; color: #991b1b; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Order Details</div>' +
    '<div style="font-size: 24px; font-weight: 800; color: #000; margin-bottom: 4px;">' + orderNumber + '</div>' +
    '<div style="font-size: 14px; color: #666;">' + orderDate + '</div>' +
    '</td></tr></table>' +
    '</td></tr>' +

    // Shipping address - IMPORTANT
    '<tr><td style="padding-bottom: 24px;">' +
    '<div style="font-weight: 700; font-size: 12px; color: #dc2626; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; border-bottom: 2px solid #dc2626; padding-bottom: 8px;">📍 Ship To</div>' +
    '<div style="font-size: 16px; line-height: 1.6; color: #111;">' +
    '<strong>' + escHtml(order.customer.firstName) + ' ' + escHtml(order.customer.lastName) + '</strong><br>' +
    escHtml(order.shipping?.address1 || '') + '<br>' +
    (order.shipping?.address2 ? escHtml(order.shipping.address2) + '<br>' : '') +
    escHtml(order.shipping?.city || '') + '<br>' +
    escHtml(order.shipping?.postcode || '') + '<br>' +
    (order.shipping?.county ? escHtml(order.shipping.county) + '<br>' : '') +
    escHtml(order.shipping?.country || 'United Kingdom') +
    '</div>' +
    (order.customer.phone ? '<div style="margin-top: 8px; font-size: 14px; color: #666;">📞 ' + escHtml(order.customer.phone) + '</div>' : '') +
    '</td></tr>' +

    // Items to fulfill
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
    '</tr>' +
    '</table>' +
    '</td></tr>' +

    // Customer email for reference
    '<tr><td style="padding: 16px; background: #f9fafb; border-radius: 8px;">' +
    '<div style="font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Customer Email</div>' +
    '<div style="font-size: 14px; color: #111;">' + escHtml(order.customer.email) + '</div>' +
    '</td></tr>' +

    // Instructions
    '<tr><td style="padding-top: 24px;">' +
    '<div style="padding: 16px; background: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 0 8px 8px 0;">' +
    '<div style="font-weight: 700; color: #92400e; margin-bottom: 4px;">⚠️ Action Required</div>' +
    '<div style="font-size: 14px; color: #78350f; line-height: 1.5;">Please package and dispatch this order as soon as possible. Once shipped, please send tracking information to <a href="mailto:orders@freshwax.co.uk" style="color: #92400e;">orders@freshwax.co.uk</a></div>' +
    '</div>' +
    '</td></tr>' +

    '</table></td></tr>' +

    // Footer
    '<tr><td align="center" style="padding: 24px 0;">' +
    '<div style="color: #6b7280; font-size: 13px;">This is an automated fulfillment request from Fresh Wax</div>' +
    `<div style="margin-top: 8px;"><a href="${SITE_URL}" style="color: #dc2626; font-size: 12px; text-decoration: none; font-weight: 600;">freshwax.co.uk</a></div>` +
    '</td></tr>' +

    '</table></td></tr></table></body></html>';
}

// Build artist notification email for digital sales (tracks/releases)
function buildDigitalSaleEmail(orderNumber: string, order: any, digitalItems: any[]): string {
  const digitalTotal = digitalItems.reduce((sum: number, item: any) => sum + (item.price * item.quantity), 0);

  // Calculate fees - use passed values or calculate from subtotal
  const subtotal = order.totals?.subtotal || digitalTotal;
  const freshWaxFee = order.totals?.freshWaxFee || (subtotal * 0.01);
  const baseAmount = subtotal + (order.totals?.shipping || 0) + freshWaxFee;
  const stripeFee = order.totals?.stripeFee || (((baseAmount * 0.014) + 0.20) / 0.986);
  const customerPaid = order.totals?.total || (subtotal + freshWaxFee + stripeFee);

  let itemsHtml = '';
  for (const item of digitalItems) {
    const typeLabel = item.type === 'track' ? 'Single Track' : 'Digital Release';
    itemsHtml += '<tr>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; color: #fff;">' + escHtml(item.name) + '<br><span style="font-size: 12px; color: #9ca3af;">' + typeLabel + '</span></td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; text-align: center; color: #fff;">' + item.quantity + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; text-align: right; font-weight: 600; color: #fff;">&pound;' + (item.price * item.quantity).toFixed(2) + '</td>' +
      '</tr>';
  }

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>' +
    '<body style="margin: 0; padding: 0; background: #000; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #000;"><tr><td align="center" style="padding: 40px 20px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px;">' +

    // Header - Fresh Wax branding
    '<tr><td style="background: #fff; padding: 32px 24px; border-radius: 12px 12px 0 0; text-align: center; border: 2px solid #dc2626; border-bottom: none;">' +
    `<img src="${SITE_URL}/logo.webp" alt="Fresh Wax" width="50" height="50" style="display: block; margin: 0 auto 12px; border-radius: 6px;">` +
    '<div style="font-size: 28px; font-weight: 800; letter-spacing: 1px;"><span style="color: #000;">FRESH</span> <span style="color: #dc2626;">WAX</span></div>' +
    '<div style="font-size: 12px; color: #666; margin-top: 4px; letter-spacing: 2px;">JUNGLE • DRUM AND BASS</div>' +
    '</td></tr>' +

    // Sale notification header
    '<tr><td style="background: #dc2626; padding: 20px 24px; text-align: center; border-left: 2px solid #dc2626; border-right: 2px solid #dc2626;">' +
    '<div style="font-size: 22px; font-weight: 800; color: #fff; letter-spacing: 1px;">🎵 DIGITAL SALE!</div>' +
    '<div style="font-size: 14px; color: rgba(255,255,255,0.9); margin-top: 6px;">Order ' + orderNumber + '</div>' +
    '</td></tr>' +

    // Content
    '<tr><td style="background: #111; padding: 24px; border-left: 2px solid #dc2626; border-right: 2px solid #dc2626; border-bottom: 2px solid #dc2626; border-radius: 0 0 12px 12px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +

    // Success message
    '<tr><td style="padding-bottom: 20px; text-align: center;">' +
    '<div style="font-size: 18px; font-weight: 700; color: #16a34a;">Someone bought your music!</div>' +
    '<div style="font-size: 14px; color: #9ca3af; margin-top: 4px;">Customer: ' + escHtml(order.customer.firstName) + ' ' + escHtml(order.customer.lastName) + '</div>' +
    '</td></tr>' +

    // Items table
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
    '<td style="padding: 12px; color: #fff; font-weight: 700; text-align: right;">£' + digitalTotal.toFixed(2) + '</td>' +
    '</tr>' +
    '</table>' +
    '</td></tr>' +

    // Payment breakdown
    '<tr><td style="padding-top: 20px;">' +
    '<div style="padding: 16px; background: #1f2937; border-radius: 8px; border: 1px solid #374151;">' +
    '<div style="font-weight: 700; font-size: 12px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">Payment Breakdown</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding: 6px 0; color: #16a34a; font-size: 15px; font-weight: 700;">Your Payment:</td><td style="padding: 6px 0; text-align: right; color: #16a34a; font-size: 15px; font-weight: 700;">£' + digitalTotal.toFixed(2) + '</td></tr>' +
    '<tr><td colspan="2" style="padding: 8px 0; border-top: 1px dashed #374151;"></td></tr>' +
    '<tr><td style="padding: 4px 0; color: #6b7280; font-size: 13px;">Processing Fee (paid by customer):</td><td style="padding: 4px 0; text-align: right; color: #6b7280; font-size: 13px;">£' + stripeFee.toFixed(2) + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #6b7280; font-size: 13px;"><span style="color: #fff;">Fresh</span> <span style="color: #dc2626;">Wax</span> Tax (paid by customer):</td><td style="padding: 4px 0; text-align: right; color: #6b7280; font-size: 13px;">£' + freshWaxFee.toFixed(2) + '</td></tr>' +
    '<tr><td colspan="2" style="padding: 8px 0; border-top: 1px dashed #374151;"></td></tr>' +
    '<tr><td style="padding: 6px 0; color: #fff; font-size: 15px; font-weight: 700;">Customer Paid:</td><td style="padding: 6px 0; text-align: right; color: #fff; font-size: 15px; font-weight: 700;">£' + customerPaid.toFixed(2) + '</td></tr>' +
    '</table>' +
    '</div>' +
    '</td></tr>' +

    '</table></td></tr>' +

    // Footer
    '<tr><td align="center" style="padding: 24px 0;">' +
    '<div style="color: #6b7280; font-size: 13px;">Automated notification from Fresh Wax</div>' +
    `<div style="margin-top: 8px;"><a href="${SITE_URL}" style="color: #dc2626; font-size: 12px; text-decoration: none; font-weight: 600;">freshwax.co.uk</a></div>` +
    '</td></tr>' +

    '</table></td></tr></table></body></html>';
}

// Build merch seller notification email
function buildMerchSaleEmail(orderNumber: string, order: any, merchItems: any[]): string {
  const merchTotal = merchItems.reduce((sum: number, item: any) => sum + (item.price * item.quantity), 0);

  // Calculate fees - use passed values or calculate from subtotal
  const subtotal = order.totals?.subtotal || merchTotal;
  const freshWaxFee = order.totals?.freshWaxFee || (subtotal * 0.01);
  const baseAmount = subtotal + (order.totals?.shipping || 0) + freshWaxFee;
  const stripeFee = order.totals?.stripeFee || (((baseAmount * 0.014) + 0.20) / 0.986);
  const customerPaid = order.totals?.total || (subtotal + freshWaxFee + stripeFee);

  let itemsHtml = '';
  for (const item of merchItems) {
    const details = [item.size ? 'Size: ' + escHtml(item.size) : '', escHtml(item.color) || ''].filter(Boolean).join(' &bull; ');
    itemsHtml += '<tr>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; color: #fff;">' +
      (item.image ? '<img src="' + escHtml(item.image) + '" width="50" height="50" style="border-radius: 4px; margin-right: 10px; vertical-align: middle;">' : '') +
      escHtml(item.name) + (details ? '<br><span style="font-size: 12px; color: #9ca3af;">' + details + '</span>' : '') + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; text-align: center; color: #fff;">' + item.quantity + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; text-align: right; font-weight: 600; color: #fff;">&pound;' + (item.price * item.quantity).toFixed(2) + '</td>' +
      '</tr>';
  }

  // Note: Shipping handled by Fresh Wax - no address shown to sellers

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>' +
    '<body style="margin: 0; padding: 0; background: #000; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #000;"><tr><td align="center" style="padding: 40px 20px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px;">' +

    // Header - Fresh Wax branding
    '<tr><td style="background: #fff; padding: 32px 24px; border-radius: 12px 12px 0 0; text-align: center; border: 2px solid #dc2626; border-bottom: none;">' +
    `<img src="${SITE_URL}/logo.webp" alt="Fresh Wax" width="50" height="50" style="display: block; margin: 0 auto 12px; border-radius: 6px;">` +
    '<div style="font-size: 28px; font-weight: 800; letter-spacing: 1px;"><span style="color: #000;">FRESH</span> <span style="color: #dc2626;">WAX</span></div>' +
    '<div style="font-size: 12px; color: #666; margin-top: 4px; letter-spacing: 2px;">JUNGLE • DRUM AND BASS</div>' +
    '</td></tr>' +

    // Sale notification header
    '<tr><td style="background: #dc2626; padding: 20px 24px; text-align: center; border-left: 2px solid #dc2626; border-right: 2px solid #dc2626;">' +
    '<div style="font-size: 22px; font-weight: 800; color: #fff; letter-spacing: 1px;">👕 MERCH ORDER!</div>' +
    '<div style="font-size: 14px; color: rgba(255,255,255,0.9); margin-top: 6px;">Order ' + orderNumber + '</div>' +
    '</td></tr>' +

    // Content
    '<tr><td style="background: #111; padding: 24px; border-left: 2px solid #dc2626; border-right: 2px solid #dc2626; border-bottom: 2px solid #dc2626; border-radius: 0 0 12px 12px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +

    // Success message
    '<tr><td style="padding-bottom: 20px; text-align: center;">' +
    '<div style="font-size: 18px; font-weight: 700; color: #16a34a;">Someone bought your merch!</div>' +
    '<div style="font-size: 14px; color: #9ca3af; margin-top: 4px;">Customer: ' + escHtml(order.customer.firstName) + ' ' + escHtml(order.customer.lastName) + '</div>' +
    '</td></tr>' +

    // Items table
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
    '<td style="padding: 12px; color: #fff; font-weight: 700; text-align: right;">£' + merchTotal.toFixed(2) + '</td>' +
    '</tr>' +
    '</table>' +
    '</td></tr>' +

    // Payment breakdown
    '<tr><td style="padding-top: 20px;">' +
    '<div style="padding: 16px; background: #1f2937; border-radius: 8px; border: 1px solid #374151;">' +
    '<div style="font-weight: 700; font-size: 12px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">Payment Breakdown</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding: 6px 0; color: #16a34a; font-size: 15px; font-weight: 700;">Your Payment:</td><td style="padding: 6px 0; text-align: right; color: #16a34a; font-size: 15px; font-weight: 700;">£' + merchTotal.toFixed(2) + '</td></tr>' +
    '<tr><td colspan="2" style="padding: 8px 0; border-top: 1px dashed #374151;"></td></tr>' +
    '<tr><td style="padding: 4px 0; color: #6b7280; font-size: 13px;">Processing Fee (paid by customer):</td><td style="padding: 4px 0; text-align: right; color: #6b7280; font-size: 13px;">£' + stripeFee.toFixed(2) + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #6b7280; font-size: 13px;"><span style="color: #fff;">Fresh</span> <span style="color: #dc2626;">Wax</span> Tax (paid by customer):</td><td style="padding: 4px 0; text-align: right; color: #6b7280; font-size: 13px;">£' + freshWaxFee.toFixed(2) + '</td></tr>' +
    '<tr><td colspan="2" style="padding: 8px 0; border-top: 1px dashed #374151;"></td></tr>' +
    '<tr><td style="padding: 6px 0; color: #fff; font-size: 15px; font-weight: 700;">Customer Paid:</td><td style="padding: 6px 0; text-align: right; color: #fff; font-size: 15px; font-weight: 700;">£' + customerPaid.toFixed(2) + '</td></tr>' +
    '</table>' +
    '</div>' +
    '</td></tr>' +

    // Info box - Fresh Wax handles shipping
    '<tr><td style="padding-top: 20px;">' +
    '<div style="padding: 16px; background: #1f2937; border-left: 4px solid #16a34a; border-radius: 0 8px 8px 0;">' +
    '<div style="font-weight: 700; color: #16a34a; margin-bottom: 4px;">✅ No Action Required</div>' +
    `<div style="font-size: 14px; color: #9ca3af; line-height: 1.5;">Fresh Wax handles all shipping and fulfilment. View your sales and earnings in your <a href="${SITE_URL}/artist/dashboard" style="color: #dc2626;">Artist Dashboard</a>.</div>` +
    '</div>' +
    '</td></tr>' +

    '</table></td></tr>' +

    // Footer
    '<tr><td align="center" style="padding: 24px 0;">' +
    '<div style="color: #6b7280; font-size: 13px;">Automated notification from Fresh Wax</div>' +
    `<div style="margin-top: 8px;"><a href="${SITE_URL}" style="color: #dc2626; font-size: 12px; text-decoration: none; font-weight: 600;">freshwax.co.uk</a></div>` +
    '</td></tr>' +

    '</table></td></tr></table></body></html>';
}
