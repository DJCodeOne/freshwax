// src/pages/api/vinyl/listing.ts
// Vinyl listing CRUD API for sellers
// Uses Firebase REST API efficiently, Pusher for real-time updates

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, setDocument, updateDocument, verifyRequestUser, queryCollection } from '../../../lib/firebase-rest';
import { d1GetVinylSeller } from '../../../lib/d1-catalog';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('vinyl/listing');

// The listing form intentionally has no shipping field — "Shipping costs are
// set in your seller settings". Resolve the per-listing shippingCost from the
// seller's settings (D1 primary, Firebase backup) when the client doesn't
// send one. Returns null when the seller has no settings yet, so callers can
// point them at /artist/vinyl/settings/ instead of silently listing with £0.
async function resolveShippingCost(
  provided: unknown,
  sellerId: string,
  db: D1Database | undefined
): Promise<number | null> {
  if (typeof provided === 'number' && provided >= 0) return provided;
  try {
    if (db) {
      const seller = await d1GetVinylSeller(db, sellerId);
      const single = seller?.shippingSingle;
      if (single !== undefined && single !== null) return parseFloat(String(single)) || 0;
    }
  } catch (e: unknown) {
    log.warn('[vinyl/listing] D1 seller settings lookup failed:', e);
  }
  try {
    const fbSeller = await getDocument('vinyl-sellers', sellerId);
    const single = fbSeller?.shippingSingle;
    if (single !== undefined && single !== null) return parseFloat(String(single)) || 0;
  } catch (e: unknown) {
    log.warn('[vinyl/listing] Firebase seller settings lookup failed:', e);
  }
  return null;
}

const vinylListingPostSchema = z.object({
  action: z.enum(['create', 'update', 'publish', 'unpublish', 'delete']),
  sellerId: z.string().min(1),
  sellerName: z.string().optional(),
  listingId: z.string().optional(),
}).strip();

export const prerender = false;

// Limits
const MAX_PRICE = 10000; // £10,000 max price
const MAX_SHIPPING = 100; // £100 max shipping
const MAX_TITLE_LENGTH = 100;
const MAX_ARTIST_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_IMAGES = 6;

// Valid condition grades (Goldmine scale)
const VALID_CONDITIONS = ['M', 'NM', 'VG+', 'VG', 'G+', 'G', 'F', 'P'];
const VALID_FORMATS = ['LP', '12"', '10"', '7"', 'Box Set', 'EP', 'Compilation', 'Other'];
const VALID_STATUSES = ['draft', 'published', 'sold', 'removed'];
const MAX_DISCOUNT = 90; // Max 90% discount
const VALID_DEAL_TYPES = ['none', 'percentage', 'collection_deal', 'clearance'];

// Generate unique listing ID
function generateListingId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `vl_${timestamp}${random}`;
}

// Validate listing data
function validateListing(data: Record<string, unknown>): { valid: boolean; error?: string } {
  if (!data.title || (data.title as string).length > MAX_TITLE_LENGTH) {
    return { valid: false, error: `Title required and must be under ${MAX_TITLE_LENGTH} characters` };
  }
  if (!data.artist || (data.artist as string).length > MAX_ARTIST_LENGTH) {
    return { valid: false, error: `Artist required and must be under ${MAX_ARTIST_LENGTH} characters` };
  }
  if (data.description && (data.description as string).length > MAX_DESCRIPTION_LENGTH) {
    return { valid: false, error: `Description must be under ${MAX_DESCRIPTION_LENGTH} characters` };
  }
  if (!data.mediaCondition || !VALID_CONDITIONS.includes(data.mediaCondition as string)) {
    return { valid: false, error: 'Valid media condition required (M, NM, VG+, VG, G+, G, F, P)' };
  }
  if (!data.sleeveCondition || !VALID_CONDITIONS.includes(data.sleeveCondition as string)) {
    return { valid: false, error: 'Valid sleeve condition required (M, NM, VG+, VG, G+, G, F, P)' };
  }
  if (data.format && !VALID_FORMATS.includes(data.format as string)) {
    return { valid: false, error: 'Invalid format' };
  }
  if (typeof data.price !== 'number' || data.price <= 0 || data.price > MAX_PRICE) {
    return { valid: false, error: `Price must be between £0.01 and £${MAX_PRICE}` };
  }
  if (typeof data.shippingCost !== 'number' || data.shippingCost < 0 || data.shippingCost > MAX_SHIPPING) {
    return { valid: false, error: `Shipping cost must be between £0 and £${MAX_SHIPPING}` };
  }
  if (data.images && (data.images as unknown[]).length > MAX_IMAGES) {
    return { valid: false, error: `Maximum ${MAX_IMAGES} images allowed` };
  }
  return { valid: true };
}

// GET - Fetch seller's listings (efficient: single query)
export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const sellerId = url.searchParams.get('sellerId');
  const listingId = url.searchParams.get('id');

  // Rate limit reads
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`vinyl-read:${clientId}`, {
    maxRequests: 100,
    windowMs: 60 * 1000 // 100 per minute
  });

  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    // Single listing fetch
    if (listingId) {
      const listing = await getDocument('vinylListings', listingId);
      if (!listing) {
        return ApiErrors.notFound('Listing not found');
      }
      return successResponse({ listing });
    }

    // Seller's listings
    if (!sellerId) {
      return ApiErrors.badRequest('Seller ID or Listing ID required');
    }

    // Query listings by sellerId using shared firebase-rest queryCollection
    const listings = await queryCollection('vinylListings', {
      filters: [{ field: 'sellerId', op: 'EQUAL', value: sellerId }],
      orderBy: 'createdAt',
      orderDirection: 'DESCENDING',
      limit: 100,
      skipCache: true
    });

    return successResponse({ listings, count: listings.length });

  } catch (error: unknown) {
    log.error('[vinyl/listing GET] Error:', error);
    return ApiErrors.serverError('Failed to fetch listings');
  }
};

// POST - Create or update listing
export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit writes: 20 per hour
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`vinyl-write:${clientId}`, {
    maxRequests: 20,
    windowMs: 60 * 60 * 1000,
    blockDurationMs: 30 * 60 * 1000
  });

  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    // Verify the user is authenticated
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
    if (authError || !verifiedUserId) {
      return ApiErrors.unauthorized('Authentication required');
    }

    const body = await request.json();

    const parsed = vinylListingPostSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { action, sellerId, sellerName, listingId } = parsed.data;
    // Listing fields come from the raw body — the Zod schema above only
    // validates the control fields and .strip() discards everything else,
    // so destructuring ...data from parsed.data yields an EMPTY object and
    // every create/update fails validation. Each listing field is
    // individually sanitised below (trim/slice/whitelist/clamp).
    const { action: _a, sellerId: _s, sellerName: _n, listingId: _l, ...data } =
      body as Record<string, any>;

    // Verify the authenticated user matches the sellerId
    if (verifiedUserId !== sellerId) {
      return ApiErrors.forbidden('You can only manage your own listings');
    }

    switch (action) {
      case 'create': {
        // Shipping comes from seller settings (the form has no shipping field)
        const resolvedShipping = await resolveShippingCost(data.shippingCost, sellerId, locals.runtime?.env?.DB);
        if (resolvedShipping === null) {
          return ApiErrors.badRequest('Please set your shipping costs in Seller Settings before creating a listing');
        }
        data.shippingCost = resolvedShipping;

        // Validate data
        const validation = validateListing(data);
        if (!validation.valid) {
          return ApiErrors.badRequest(validation.error);
        }

        const newId = generateListingId();
        const now = new Date().toISOString();

        // Process tracks - sanitize each track object
        const tracks = (data.tracks || []).slice(0, 20).map((track: Record<string, unknown>, index: number) => ({
          position: index + 1,
          side: ['A', 'B', 'C', 'D'].includes(track.side as string) ? track.side : 'A',
          name: ((track.name as string) || '').trim().slice(0, 100),
          audioSampleUrl: track.audioSampleUrl || null,
          audioSampleDuration: track.audioSampleDuration || null
        }));

        // Process discount/deal info
        const discountPercent = Math.min(Math.max(parseInt(data.discountPercent) || 0, 0), MAX_DISCOUNT);
        const dealType = VALID_DEAL_TYPES.includes(data.dealType) ? data.dealType : 'none';
        const originalPrice = parseFloat(data.price.toFixed(2));
        const salePrice = discountPercent > 0
          ? parseFloat((originalPrice * (1 - discountPercent / 100)).toFixed(2))
          : parseFloat(originalPrice.toFixed(2));

        const listing = {
          id: newId,
          sellerId,
          sellerName: sellerName || 'Unknown Seller',
          title: data.title.trim().slice(0, MAX_TITLE_LENGTH),
          artist: data.artist.trim().slice(0, MAX_ARTIST_LENGTH),
          label: (data.label || '').trim().slice(0, 100),
          catalogNumber: (data.catalogNumber || '').trim().slice(0, 50),
          format: data.format || 'LP',
          releaseYear: (() => {
            const year = data.releaseYear ? parseInt(data.releaseYear) : null;
            if (year && (year < 1900 || year > new Date().getFullYear() + 5)) return null;
            return year;
          })(),
          genre: (data.genre || '').trim().slice(0, 50),
          mediaCondition: data.mediaCondition,
          sleeveCondition: data.sleeveCondition,
          conditionNotes: (data.conditionNotes || '').trim().slice(0, 500),
          price: salePrice,
          originalPrice: originalPrice,
          discountPercent: discountPercent,
          dealType: dealType,
          dealDescription: (data.dealDescription || '').trim().slice(0, 200),
          shippingCost: Math.round((data.shippingCost || 0) * 100) / 100,
          description: (data.description || '').trim().slice(0, MAX_DESCRIPTION_LENGTH),
          images: (data.images || []).slice(0, MAX_IMAGES),
          tracks: tracks,
          // Legacy fields for backward compatibility
          audioSampleUrl: tracks.length > 0 && tracks[0].audioSampleUrl ? tracks[0].audioSampleUrl : (data.audioSampleUrl || null),
          audioSampleDuration: tracks.length > 0 && tracks[0].audioSampleDuration ? tracks[0].audioSampleDuration : (data.audioSampleDuration || null),
          status: 'draft',
          views: 0,
          saves: 0,
          createdAt: now,
          updatedAt: now
        };

        await setDocument('vinylListings', newId, listing);

        // Update seller's listing count
        try {
          const seller = await getDocument('vinylSellers', sellerId);
          if (seller) {
            await updateDocument('vinylSellers', sellerId, {
              totalListings: (seller.totalListings || 0) + 1,
              updatedAt: now
            });
          }
        } catch (e: unknown) {
          log.warn('[vinyl/listing] Failed to update seller count:', e);
        }

        return successResponse({ listing, listingId: newId }, 201);
      }

      case 'update': {
        if (!listingId) {
          return ApiErrors.badRequest('Listing ID required');
        }

        // Verify ownership
        const existing = await getDocument('vinylListings', listingId);
        if (!existing) {
          return ApiErrors.notFound('Listing not found');
        }
        if (existing.sellerId !== sellerId) {
          return ApiErrors.forbidden('Not authorized to edit this listing');
        }

        // Build update object
        const updateData: Record<string, unknown> = { updatedAt: new Date().toISOString() };

        const allowedFields = [
          'title', 'artist', 'label', 'catalogNumber', 'format', 'releaseYear',
          'genre', 'mediaCondition', 'sleeveCondition', 'conditionNotes',
          'shippingCost', 'description', 'images', 'tracks', 'audioSampleUrl', 'audioSampleDuration',
          'dealType', 'dealDescription'
        ];

        // If tracks are being updated, sanitize them
        if (data.tracks) {
          data.tracks = data.tracks.slice(0, 20).map((track: Record<string, unknown>, index: number) => ({
            position: index + 1,
            side: ['A', 'B', 'C', 'D'].includes(track.side as string) ? track.side : 'A',
            name: ((track.name as string) || '').trim().slice(0, 100),
            audioSampleUrl: track.audioSampleUrl || null,
            audioSampleDuration: track.audioSampleDuration || null
          }));
        }

        for (const field of allowedFields) {
          if (data[field] !== undefined) {
            updateData[field] = data[field];
          }
        }

        // Validate releaseYear bounds if provided
        if (updateData.releaseYear !== undefined) {
          const year = updateData.releaseYear ? parseInt(updateData.releaseYear) : null;
          if (year && (year < 1900 || year > new Date().getFullYear() + 5)) {
            updateData.releaseYear = null;
          } else {
            updateData.releaseYear = year;
          }
        }

        // Handle price and discount updates together
        if (data.price !== undefined || data.discountPercent !== undefined) {
          const newPrice = data.price !== undefined ? parseFloat(data.price) : existing.originalPrice || existing.price;
          const newDiscount = data.discountPercent !== undefined
            ? Math.min(Math.max(parseInt(data.discountPercent) || 0, 0), MAX_DISCOUNT)
            : existing.discountPercent || 0;

          updateData.originalPrice = parseFloat(newPrice.toFixed(2));
          updateData.discountPercent = newDiscount;
          updateData.price = newDiscount > 0
            ? parseFloat((newPrice * (1 - newDiscount / 100)).toFixed(2))
            : parseFloat(newPrice.toFixed(2));
        }

        // Validate deal type if provided
        if (data.dealType !== undefined) {
          updateData.dealType = VALID_DEAL_TYPES.includes(data.dealType) ? data.dealType : 'none';
        }

        // Validate if price/conditions changed
        const testData = { ...existing, ...updateData };
        const validation = validateListing(testData);
        if (!validation.valid) {
          return ApiErrors.badRequest(validation.error);
        }

        await updateDocument('vinylListings', listingId, updateData);

        return successResponse({ message: 'Listing updated' });
      }

      case 'publish': {
        if (!listingId) {
          return ApiErrors.badRequest('Listing ID required');
        }

        const existing = await getDocument('vinylListings', listingId);
        if (!existing || existing.sellerId !== sellerId) {
          return ApiErrors.forbidden('Not authorized');
        }

        // Must have at least one image
        if (!existing.images || existing.images.length === 0) {
          return ApiErrors.badRequest('At least one image required to publish');
        }

        // Backfill shipping from seller settings for drafts that predate it —
        // a published listing must have a shippingCost for checkout to charge
        const publishUpdate: Record<string, unknown> = {
          status: 'published',
          publishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        if (existing.shippingCost === undefined || existing.shippingCost === null) {
          const backfilled = await resolveShippingCost(undefined, sellerId, locals.runtime?.env?.DB);
          if (backfilled === null) {
            return ApiErrors.badRequest('Please set your shipping costs in Seller Settings before publishing');
          }
          publishUpdate.shippingCost = backfilled;
        }

        // Go live immediately - no approval needed
        await updateDocument('vinylListings', listingId, publishUpdate);

        return successResponse({ message: 'Listing is now live!' });
      }

      case 'unpublish': {
        if (!listingId) {
          return ApiErrors.badRequest('Listing ID required');
        }

        const existing = await getDocument('vinylListings', listingId);
        if (!existing || existing.sellerId !== sellerId) {
          return ApiErrors.forbidden('Not authorized');
        }

        await updateDocument('vinylListings', listingId, {
          status: 'draft',
          updatedAt: new Date().toISOString()
        });

        return successResponse({ message: 'Listing unpublished' });
      }

      case 'delete': {
        if (!listingId) {
          return ApiErrors.badRequest('Listing ID required');
        }

        const existing = await getDocument('vinylListings', listingId);
        if (!existing || existing.sellerId !== sellerId) {
          return ApiErrors.forbidden('Not authorized');
        }

        // Soft delete
        await updateDocument('vinylListings', listingId, {
          deleted: true,
          deletedAt: new Date().toISOString(),
          status: 'removed',
          updatedAt: new Date().toISOString()
        });

        return successResponse({ message: 'Listing deleted' });
      }

      default:
        return ApiErrors.badRequest('Invalid action');
    }

  } catch (error: unknown) {
    log.error('[vinyl/listing POST] Error:', error);
    return ApiErrors.serverError('Server error');
  }
};
