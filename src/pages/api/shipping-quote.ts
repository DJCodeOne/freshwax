// src/pages/api/shipping-quote.ts
// Authoritative shipping quote for the cart/checkout UI so the DISPLAYED total
// matches what Stripe/PayPal will actually charge. Runs the SAME shipping-rules
// helpers the checkout endpoints use (per-artist release vinyl, per-seller
// combined crates, flat/free merch), after enriching cart items with the
// server-side shipping rates (which aren't stored on the client cart item).

import type { APIRoute } from 'astro';
import { getDocument } from '../../lib/firebase-rest';
import {
  applyCrateCombinedShipping,
  applyCrateFreeShipping,
  computeMerchShipping,
  computeReleaseVinylShipping,
  regionForCountry,
} from '../../lib/order/shipping-rules';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';

const log = createLogger('shipping-quote');
export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rl = checkRateLimit(`shipping-quote:${clientId}`, { maxRequests: 60, windowMs: 60 * 1000 });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter!);

  let body: { items?: Record<string, unknown>[]; country?: string };
  try {
    body = await request.json();
  } catch {
    return ApiErrors.badRequest('Invalid JSON');
  }

  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length > 100) return ApiErrors.badRequest('Too many items');
  const region = regionForCountry(body.country || 'GB');
  const db = locals.runtime?.env?.DB;

  try {
    // Enrich items with server-side shipping rates (the cart item doesn't carry them).
    for (const item of items) {
      if (item.type !== 'vinyl') continue;
      const isCrate = item.sellerId && !item.releaseId;
      if (isCrate) {
        const listingId = (item.crateListingId || item.listingId || item.id) as string | undefined;
        if (item.cratesShippingCost == null && listingId) {
          const listing = await getDocument('vinylListings', listingId).catch(() => null);
          if (listing) {
            item.cratesShippingCost = listing.shippingCost || 0;
            if (!item.sellerId) item.sellerId = (listing.sellerId || listing.userId) as string;
          }
        }
      } else if (item.releaseId) {
        if (item.vinylShippingUK == null) {
          const release = await getDocument('releases', item.releaseId as string).catch(() => null);
          if (release) {
            item.vinylShippingUK = release.vinylShippingUK;
            item.vinylShippingEU = release.vinylShippingEU;
            item.vinylShippingIntl = release.vinylShippingIntl;
            item.vinylShippingAdditional = release.vinylShippingAdditional;
            const aid = (item.artistId || release.artistId || release.userId) as string | undefined;
            if (aid) {
              item.artistId = aid;
              const artist = await getDocument('artists', aid).catch(() => null);
              if (artist) {
                item.artistVinylShippingUK = artist.vinylShippingUK;
                item.artistVinylShippingEU = artist.vinylShippingEU;
                item.artistVinylShippingIntl = artist.vinylShippingIntl;
                item.artistVinylShippingAdditional = artist.vinylShippingAdditional;
              }
            }
          }
        }
      }
    }

    // Same order as the checkout endpoints: combine crate shipping per seller,
    // then waive where a free-shipping threshold is met.
    await applyCrateCombinedShipping(items as never, db);
    await applyCrateFreeShipping(items as never, db);

    const merch = items.some(i => i.type === 'merch') ? await computeMerchShipping(items as never) : 0;
    const releaseVinyl = computeReleaseVinylShipping(items as never, region).total;
    let crate = 0;
    for (const i of items) {
      if (i.type === 'vinyl' && i.sellerId && !i.releaseId) {
        crate += ((Number(i.cratesShippingCost) || 0) * (Number(i.quantity) || 1));
      }
    }
    crate = Math.round(crate * 100) / 100;
    const shipping = Math.round((merch + releaseVinyl + crate) * 100) / 100;

    return successResponse({ shipping, region, breakdown: { merch, releaseVinyl, crate } });
  } catch (e: unknown) {
    log.error('quote error', e);
    return ApiErrors.serverError('Failed to quote shipping');
  }
};
