// src/pages/api/create-order.ts
// Creates order in Firebase and sends confirmation email
// Orchestrator — price validation, stock updates, and emails are in src/lib/order/
// AUTH: Called after Stripe/PayPal payment confirmation. Guest checkout is supported,
// so no user auth is required. Server-side price validation prevents manipulation.
// Payment is already captured by the payment provider before this endpoint runs.

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, addDocument, atomicIncrement, updateDocument } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { generateOrderNumber } from '../../lib/order-utils';
import { applyCrateCombinedShipping, applyCrateFreeShipping, computeMerchShipping, computeReleaseVinylShipping } from '../../lib/order/shipping-rules';
import { successResponse, ApiErrors, createLogger, maskEmail } from '../../lib/api-utils';
import { validateOrderPrices } from '../../lib/order/price-validation';
import { updateMerchStockAfterOrder } from '../../lib/order/merch-stock-update';
import { sendOrderEmails } from '../../lib/order/email-sender';
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

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: strict - 5 orders per minute per IP (prevents order spam)
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`create-order:${clientId}`, RateLimiters.strict);
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  // Initialize Firebase for Cloudflare runtime
  const env = locals.runtime.env;

  try {
    let rawBody;
    try {
      rawBody = await request.json();
    } catch {
      return ApiErrors.badRequest('Invalid JSON');
    }

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
      log.info('[create-order] Guest checkout for:', maskEmail(orderData.customer.email));
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

    // Seller-configurable free-shipping rules (crates seller settings +
    // merch supplier settings); no global free-over-£50 rule any more
    await applyCrateCombinedShipping(pricedItems as unknown as Parameters<typeof applyCrateCombinedShipping>[0], locals.runtime?.env?.DB);
    await applyCrateFreeShipping(pricedItems as Record<string, unknown>[], locals.runtime?.env?.DB);

    if (hasMerchItems) {
      merchShipping = await computeMerchShipping(pricedItems as Record<string, unknown>[]);
    }

    if (hasVinylItems) {
      for (const item of pricedItems) {
        if (item.type !== 'vinyl') continue;

        if (item.sellerId && !item.releaseId) {
          // Vinyl crates — seller shipping cost (validated server-side as
          // cratesShippingCost; legacy items may carry shippingCost)
          vinylShippingTotal += item.cratesShippingCost ?? item.shippingCost ?? 4.99;
        }
        // Per-artist release-vinyl shipping (first record single rate, each
        // additional record at 50p default) is computed below via the shared
        // computeReleaseVinylShipping helper.
      }

      const vinylRegion = isUK ? 'UK' : isEU ? 'EU' : 'INTL';
      const relVinyl = computeReleaseVinylShipping(pricedItems as unknown as Parameters<typeof computeReleaseVinylShipping>[0], vinylRegion);
      vinylShippingTotal += relVinyl.total;
      Object.assign(artistShippingBreakdown, relVinyl.breakdown);
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
    // Use Promise.allSettled so a single failed enrichment doesn't block the entire order
    const downloadResults = await Promise.allSettled(pricedItems.map(async (item: OrderItem) => {
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
              let track: TrackData | null = null;
              const releaseTracks: TrackData[] = (releaseData?.tracks || []) as TrackData[];

              // The cart builds trackIds as `<releaseId>-track-<n>` (1-indexed
              // display number), but tracks in the release array use 0-indexed
              // `trackNumber`. Extract the suffix and try BOTH indexings so we
              // match either convention (compilations bit us when cart's
              // 1-indexed "track-6" was compared raw against the full string).
              let trackIdSuffixNum: number | null = null;
              if (item.trackId) {
                const m = String(item.trackId).match(/-track-(\d+)$/);
                if (m) trackIdSuffixNum = parseInt(m[1], 10);
              }

              // Method 1: Match by direct id/trackId fields, or by parsed suffix
              // against trackNumber (try suffix as-is and suffix-1 to cover
              // both 0-indexed and 1-indexed track arrays).
              if (item.trackId) {
                track = releaseTracks.find((t: TrackData) =>
                  t.id === item.trackId ||
                  t.trackId === item.trackId ||
                  String(t.trackNumber) === String(item.trackId)
                ) || null;
                if (!track && trackIdSuffixNum != null) {
                  track = releaseTracks.find((t: TrackData) =>
                    Number(t.trackNumber) === trackIdSuffixNum ||
                    Number(t.trackNumber) === trackIdSuffixNum - 1 ||
                    Number(t.displayTrackNumber) === trackIdSuffixNum
                  ) || null;
                }
              }

              // Method 2: Match by track name. For compilation tracks where the
              // stored trackName is "Artist - Title", a strict-equal check on
              // just the title fails. Try exact first, then substring, on
              // BOTH the item name's last-segment and item.title.
              const splitTrailing = (s: string) => {
                const parts = s.split(' - ');
                return parts.length > 1 ? parts.slice(1).join(' - ') : s;
              };
              const candidates = [item.title, item.name ? splitTrailing(item.name) : null]
                .filter((s): s is string => !!s)
                .map((s) => s.toLowerCase().trim());

              if (!track && candidates.length) {
                // Pass 1: exact equality (handles cleanly-named singles)
                track = releaseTracks.find((t: TrackData) => {
                  const name = (t.trackName || t.name || '').toLowerCase().trim();
                  return candidates.some((c) => name === c);
                }) || null;
              }
              if (!track && candidates.length) {
                // Pass 2: substring (handles "Artist - Title" compilations)
                track = releaseTracks.find((t: TrackData) => {
                  const name = (t.trackName || t.name || '').toLowerCase();
                  return candidates.some((c) => c.length >= 3 && name.includes(c));
                }) || null;
              }

              log.info('[create-order] Single track found:', track ? (track.trackName || track.name) : 'NOT FOUND', 'for trackId:', item.trackId);

              // Get artist and release name for filename
              const artistName = releaseData?.artistName || item.artist || 'Unknown Artist';
              const releaseName = releaseData?.releaseName || releaseData?.title || item.title || 'Release';
              const artworkUrl = releaseData?.originalArtworkUrl || releaseData?.coverArtUrl || releaseData?.artwork?.cover || releaseData?.artwork?.artworkUrl || item.artwork || item.image || null;

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
                // No match — DO NOT fall through to all-tracks. Returning the
                // full release for a single-track purchase gives buyers free
                // music (Oren's "Twisted Assasin" purchase shipped 13 tracks).
                // Save the order with placeholder URLs so the buyer can be
                // helped manually instead of silently overdelivering.
                log.error('[create-order] Could not match single track — returning placeholder. trackId:', item.trackId, 'item.name:', item.name, 'releaseId:', releaseId);
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
                      name: item.title || (item.name ? splitTrailing(item.name) : 'Track'),
                      mp3Url: null,
                      wavUrl: null,
                      _matchFailed: true,
                    }]
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
    const itemsWithDownloads = downloadResults.map((result, i) =>
      result.status === 'fulfilled' ? result.value : { ...pricedItems[i], releaseId: pricedItems[i].releaseId || pricedItems[i].productId || pricedItems[i].id }
    );

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
    await updateMerchStockAfterOrder({
      items: order.items,
      orderRefId: orderRef.id,
      orderNumber,
      now,
      idToken,
      env
    });

    // Log item artwork data for debugging
    for (const item of order.items) {
      log.info('[create-order] Item for email:', item.name, '| artwork:', item.artwork, '| image:', item.image, '| downloads.artworkUrl:', item.downloads?.artworkUrl);
    }

    // Send all order-related emails (confirmation, stockist, artist, merch seller)
    await sendOrderEmails({
      order,
      orderRefId: orderRef.id,
      orderNumber,
      env
    });

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
