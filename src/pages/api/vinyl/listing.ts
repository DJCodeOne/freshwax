// src/pages/api/vinyl/listing.ts
// Vinyl listing CRUD API for sellers
// Uses Firebase REST API efficiently, Pusher for real-time updates

import type { APIRoute } from 'astro';
import { getDocument, setDocument, updateDocument, deleteDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../../lib/rate-limit';

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
const VALID_STATUSES = ['draft', 'pending', 'published', 'sold', 'removed'];

// Generate unique listing ID
function generateListingId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `vl_${timestamp}${random}`;
}

// Validate listing data
function validateListing(data: any): { valid: boolean; error?: string } {
  if (!data.title || data.title.length > MAX_TITLE_LENGTH) {
    return { valid: false, error: `Title required and must be under ${MAX_TITLE_LENGTH} characters` };
  }
  if (!data.artist || data.artist.length > MAX_ARTIST_LENGTH) {
    return { valid: false, error: `Artist required and must be under ${MAX_ARTIST_LENGTH} characters` };
  }
  if (data.description && data.description.length > MAX_DESCRIPTION_LENGTH) {
    return { valid: false, error: `Description must be under ${MAX_DESCRIPTION_LENGTH} characters` };
  }
  if (!data.mediaCondition || !VALID_CONDITIONS.includes(data.mediaCondition)) {
    return { valid: false, error: 'Valid media condition required (M, NM, VG+, VG, G+, G, F, P)' };
  }
  if (!data.sleeveCondition || !VALID_CONDITIONS.includes(data.sleeveCondition)) {
    return { valid: false, error: 'Valid sleeve condition required (M, NM, VG+, VG, G+, G, F, P)' };
  }
  if (data.format && !VALID_FORMATS.includes(data.format)) {
    return { valid: false, error: 'Invalid format' };
  }
  if (typeof data.price !== 'number' || data.price <= 0 || data.price > MAX_PRICE) {
    return { valid: false, error: `Price must be between £0.01 and £${MAX_PRICE}` };
  }
  if (typeof data.shippingCost !== 'number' || data.shippingCost < 0 || data.shippingCost > MAX_SHIPPING) {
    return { valid: false, error: `Shipping cost must be between £0 and £${MAX_SHIPPING}` };
  }
  if (data.images && data.images.length > MAX_IMAGES) {
    return { valid: false, error: `Maximum ${MAX_IMAGES} images allowed` };
  }
  return { valid: true };
}

// Initialize Firebase from env
function initFirebase(locals: any) {
  const env = locals?.runtime?.env || {};
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

// GET - Fetch seller's listings (efficient: single query)
export const GET: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);

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
        return new Response(JSON.stringify({ success: false, error: 'Listing not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ success: true, listing }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Seller's listings - use direct Firestore REST query for efficiency
    if (!sellerId) {
      return new Response(JSON.stringify({ success: false, error: 'Seller ID or Listing ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Query listings by sellerId (single read operation)
    const projectId = import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const apiKey = import.meta.env.FIREBASE_API_KEY;

    const queryUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery?key=${apiKey}`;

    const queryResponse = await fetch(queryUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'vinylListings' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'sellerId' },
              op: 'EQUAL',
              value: { stringValue: sellerId }
            }
          },
          orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }],
          limit: 100
        }
      })
    });

    const results = await queryResponse.json();

    const listings = results
      .filter((r: any) => r.document)
      .map((r: any) => {
        const doc = r.document;
        const id = doc.name.split('/').pop();
        const fields = doc.fields || {};

        // Parse Firestore document format
        const parseValue = (v: any): any => {
          if (!v) return null;
          if (v.stringValue !== undefined) return v.stringValue;
          if (v.integerValue !== undefined) return parseInt(v.integerValue);
          if (v.doubleValue !== undefined) return v.doubleValue;
          if (v.booleanValue !== undefined) return v.booleanValue;
          if (v.arrayValue) return (v.arrayValue.values || []).map(parseValue);
          if (v.mapValue) {
            const obj: any = {};
            for (const [k, val] of Object.entries(v.mapValue.fields || {})) {
              obj[k] = parseValue(val);
            }
            return obj;
          }
          return null;
        };

        const listing: any = { id };
        for (const [key, value] of Object.entries(fields)) {
          listing[key] = parseValue(value);
        }
        return listing;
      });

    return new Response(JSON.stringify({ success: true, listings, count: listings.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[vinyl/listing GET] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Failed to fetch listings' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST - Create or update listing
export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);

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
    const body = await request.json();
    const { action, sellerId, sellerName, listingId, ...data } = body;

    if (!sellerId) {
      return new Response(JSON.stringify({ success: false, error: 'Seller ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    switch (action) {
      case 'create': {
        // Validate data
        const validation = validateListing(data);
        if (!validation.valid) {
          return new Response(JSON.stringify({ success: false, error: validation.error }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const newId = generateListingId();
        const now = new Date().toISOString();

        const listing = {
          id: newId,
          sellerId,
          sellerName: sellerName || 'Unknown Seller',
          title: data.title.trim().slice(0, MAX_TITLE_LENGTH),
          artist: data.artist.trim().slice(0, MAX_ARTIST_LENGTH),
          label: (data.label || '').trim().slice(0, 100),
          catalogNumber: (data.catalogNumber || '').trim().slice(0, 50),
          format: data.format || 'LP',
          releaseYear: data.releaseYear ? parseInt(data.releaseYear) : null,
          genre: (data.genre || '').trim().slice(0, 50),
          mediaCondition: data.mediaCondition,
          sleeveCondition: data.sleeveCondition,
          conditionNotes: (data.conditionNotes || '').trim().slice(0, 500),
          price: Math.round(data.price * 100) / 100,
          shippingCost: Math.round((data.shippingCost || 0) * 100) / 100,
          description: (data.description || '').trim().slice(0, MAX_DESCRIPTION_LENGTH),
          images: (data.images || []).slice(0, MAX_IMAGES),
          audioSampleUrl: data.audioSampleUrl || null,
          audioSampleDuration: data.audioSampleDuration || null,
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
        } catch (e) {
          console.warn('[vinyl/listing] Failed to update seller count:', e);
        }

        return new Response(JSON.stringify({ success: true, listing, listingId: newId }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      case 'update': {
        if (!listingId) {
          return new Response(JSON.stringify({ success: false, error: 'Listing ID required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Verify ownership
        const existing = await getDocument('vinylListings', listingId);
        if (!existing) {
          return new Response(JSON.stringify({ success: false, error: 'Listing not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (existing.sellerId !== sellerId) {
          return new Response(JSON.stringify({ success: false, error: 'Not authorized to edit this listing' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Build update object
        const updateData: any = { updatedAt: new Date().toISOString() };

        const allowedFields = [
          'title', 'artist', 'label', 'catalogNumber', 'format', 'releaseYear',
          'genre', 'mediaCondition', 'sleeveCondition', 'conditionNotes',
          'price', 'shippingCost', 'description', 'images', 'audioSampleUrl', 'audioSampleDuration'
        ];

        for (const field of allowedFields) {
          if (data[field] !== undefined) {
            updateData[field] = data[field];
          }
        }

        // Validate if price/conditions changed
        const testData = { ...existing, ...updateData };
        const validation = validateListing(testData);
        if (!validation.valid) {
          return new Response(JSON.stringify({ success: false, error: validation.error }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        await updateDocument('vinylListings', listingId, updateData);

        return new Response(JSON.stringify({ success: true, message: 'Listing updated' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      case 'publish': {
        if (!listingId) {
          return new Response(JSON.stringify({ success: false, error: 'Listing ID required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const existing = await getDocument('vinylListings', listingId);
        if (!existing || existing.sellerId !== sellerId) {
          return new Response(JSON.stringify({ success: false, error: 'Not authorized' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Must have at least one image
        if (!existing.images || existing.images.length === 0) {
          return new Response(JSON.stringify({ success: false, error: 'At least one image required to publish' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        await updateDocument('vinylListings', listingId, {
          status: 'pending', // Goes to admin for approval
          submittedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });

        return new Response(JSON.stringify({ success: true, message: 'Listing submitted for review' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      case 'unpublish': {
        if (!listingId) {
          return new Response(JSON.stringify({ success: false, error: 'Listing ID required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const existing = await getDocument('vinylListings', listingId);
        if (!existing || existing.sellerId !== sellerId) {
          return new Response(JSON.stringify({ success: false, error: 'Not authorized' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        await updateDocument('vinylListings', listingId, {
          status: 'draft',
          updatedAt: new Date().toISOString()
        });

        return new Response(JSON.stringify({ success: true, message: 'Listing unpublished' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      case 'delete': {
        if (!listingId) {
          return new Response(JSON.stringify({ success: false, error: 'Listing ID required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const existing = await getDocument('vinylListings', listingId);
        if (!existing || existing.sellerId !== sellerId) {
          return new Response(JSON.stringify({ success: false, error: 'Not authorized' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Soft delete
        await updateDocument('vinylListings', listingId, {
          deleted: true,
          deletedAt: new Date().toISOString(),
          status: 'removed',
          updatedAt: new Date().toISOString()
        });

        return new Response(JSON.stringify({ success: true, message: 'Listing deleted' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      default:
        return new Response(JSON.stringify({ success: false, error: 'Invalid action' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
    }

  } catch (error) {
    console.error('[vinyl/listing POST] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
