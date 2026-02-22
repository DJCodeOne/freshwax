// src/pages/api/vinyl/public.ts
// Public API for fetching published vinyl listings and collections
// No auth required - public browsing

import type { APIRoute } from 'astro';

import { saQueryCollection, saGetDocument, getServiceAccountKey } from '../../../lib/firebase-service-account';
import { d1GetAllCollections } from '../../../lib/d1-catalog';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../../lib/rate-limit';
import { ApiErrors, createLogger } from '../../../lib/api-utils';

const log = createLogger('vinyl/public');

export const prerender = false;

// GET - Fetch published vinyl listings, collections, and deals
export const GET: APIRoute = async ({ request, locals }) => {  const env = locals.runtime.env || {};
  const db = env.DB;

  const url = new URL(request.url);
  const type = url.searchParams.get('type') || 'listings'; // listings, collections, deals, single
  const collectionId = url.searchParams.get('collection'); // Filter by seller collection
  const listingId = url.searchParams.get('id'); // Single listing
  const genre = url.searchParams.get('genre'); // Filter by genre
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);

  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`vinyl-public:${clientId}`, {
    maxRequests: 120,
    windowMs: 60 * 1000
  });

  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const serviceAccountKey = getServiceAccountKey(env);
    const projectId = env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      return ApiErrors.serverError('Service not configured');
    }

    // Get single listing
    if (type === 'single' && listingId) {
      const listing = await saGetDocument(serviceAccountKey, projectId, 'vinylListings', listingId);

      if (!listing || listing.status !== 'published') {
        return ApiErrors.notFound('Listing not found');
      }

      return successResponse({ listing });
    }

    // Get collections (sellers with listings)
    if (type === 'collections') {
      let collections: Record<string, unknown>[] = [];

      // Try D1 first
      if (db) {
        try {
          collections = await d1GetAllCollections(db);
        } catch (e: unknown) {
          log.error('[vinyl/public] D1 collections error:', e);
        }
      }

      // Fallback to Firebase if needed
      if (collections.length === 0) {
        const sellers = await saQueryCollection(serviceAccountKey, projectId, 'vinyl-sellers', {
          orderBy: { field: 'collectionNumber', direction: 'ASCENDING' },
          limit: 50
        });
        collections = sellers.map((s: Record<string, unknown>) => ({
          id: s.userId || s.id,
          collectionNumber: s.collectionNumber,
          storeName: s.storeName || `Collection ${s.collectionNumber}`,
          location: s.location || '',
          description: s.description || ''
        }));
      }

      return successResponse({ collections });
    }

    // Get deals (listings with discounts)
    if (type === 'deals') {
      // Query just by status (no orderBy to avoid needing composite index)
      const listings = await saQueryCollection(serviceAccountKey, projectId, 'vinylListings', {
        filters: [
          { field: 'status', op: 'EQUAL', value: 'published' }
        ],
        limit: 200 // Fetch more since we'll filter
      });

      // Filter for deals (discountPercent > 0) and sort client-side
      const deals = listings
        .filter((l: Record<string, unknown>) => l.discountPercent && (l.discountPercent as number) > 0)
        .sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
          const dateA = new Date((a.publishedAt as string) || (a.createdAt as string)).getTime();
          const dateB = new Date((b.publishedAt as string) || (b.createdAt as string)).getTime();
          return dateB - dateA;
        })
        .slice(0, limit);

      return successResponse({ listings: deals,
        count: deals.length });
    }

    // Default: Get published listings
    // Query just by status (no orderBy to avoid needing composite index)
    let listings: Record<string, unknown>[];

    if (collectionId) {
      // Filter by seller - just query by sellerId (single field)
      listings = await saQueryCollection(serviceAccountKey, projectId, 'vinylListings', {
        filters: [
          { field: 'sellerId', op: 'EQUAL', value: collectionId }
        ],
        limit: 200
      });
      // Then filter for published status client-side
      listings = listings.filter((l: Record<string, unknown>) => l.status === 'published');
    } else {
      // No collection filter - query by status
      listings = await saQueryCollection(serviceAccountKey, projectId, 'vinylListings', {
        filters: [
          { field: 'status', op: 'EQUAL', value: 'published' }
        ],
        limit: 200
      });
    }

    // Sort client-side by publishedAt DESC
    listings.sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
      const dateA = new Date((a.publishedAt as string) || (a.createdAt as string)).getTime();
      const dateB = new Date((b.publishedAt as string) || (b.createdAt as string)).getTime();
      return dateB - dateA;
    });

    // Client-side filter for genre (Firebase doesn't support multiple field filters easily)
    let filteredListings = listings;
    if (genre && genre !== 'all') {
      filteredListings = listings.filter((l: Record<string, unknown>) => l.genre === genre);
    }

    // Get unique genres for filter
    const genres = [...new Set(listings.map((l: Record<string, unknown>) => l.genre as string).filter(Boolean))];

    return successResponse({ listings: filteredListings,
      count: filteredListings.length,
      genres });

  } catch (error: unknown) {
    log.error('[vinyl/public GET] Error:', error);
    return ApiErrors.serverError('Failed to fetch data');
  }
};
