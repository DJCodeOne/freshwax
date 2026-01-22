// src/pages/api/vinyl/public.ts
// Public API for fetching published vinyl listings and collections
// No auth required - public browsing

import type { APIRoute } from 'astro';
import { initFirebaseEnv } from '../../../lib/firebase-rest';
import { saQueryCollection, saGetDocument } from '../../../lib/firebase-service-account';
import { d1GetAllCollections } from '../../../lib/d1-catalog';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../../lib/rate-limit';

export const prerender = false;

// Get service account key from environment
function getServiceAccountKey(env: any): string | null {
  let serviceAccountKey = env?.FIREBASE_SERVICE_ACCOUNT || env?.FIREBASE_SERVICE_ACCOUNT_KEY ||
                          import.meta.env.FIREBASE_SERVICE_ACCOUNT || import.meta.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (!serviceAccountKey) {
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

    if (clientEmail && privateKey) {
      serviceAccountKey = JSON.stringify({
        type: 'service_account',
        project_id: projectId,
        private_key_id: 'auto',
        private_key: privateKey.replace(/\\n/g, '\n'),
        client_email: clientEmail,
        client_id: 'auto',
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token'
      });
    }
  }

  return serviceAccountKey || null;
}

// Initialize Firebase from env
function initFirebase(locals: any) {
  const env = locals?.runtime?.env || {};
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

// GET - Fetch published vinyl listings, collections, and deals
export const GET: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  const env = (locals as any)?.runtime?.env || {};
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
      return new Response(JSON.stringify({ success: false, error: 'Service not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get single listing
    if (type === 'single' && listingId) {
      const listing = await saGetDocument(serviceAccountKey, projectId, 'vinylListings', listingId);

      if (!listing || listing.status !== 'published') {
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

    // Get collections (sellers with listings)
    if (type === 'collections') {
      let collections: any[] = [];

      // Try D1 first
      if (db) {
        try {
          collections = await d1GetAllCollections(db);
        } catch (e) {
          console.error('[vinyl/public] D1 collections error:', e);
        }
      }

      // Fallback to Firebase if needed
      if (collections.length === 0) {
        const sellers = await saQueryCollection(serviceAccountKey, projectId, 'vinyl-sellers', {
          orderBy: { field: 'collectionNumber', direction: 'ASCENDING' },
          limit: 50
        });
        collections = sellers.map((s: any) => ({
          id: s.userId || s.id,
          collectionNumber: s.collectionNumber,
          storeName: s.storeName || `Collection ${s.collectionNumber}`,
          location: s.location || '',
          description: s.description || ''
        }));
      }

      return new Response(JSON.stringify({ success: true, collections }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
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
        .filter((l: any) => l.discountPercent && l.discountPercent > 0)
        .sort((a: any, b: any) => {
          const dateA = new Date(a.publishedAt || a.createdAt).getTime();
          const dateB = new Date(b.publishedAt || b.createdAt).getTime();
          return dateB - dateA;
        })
        .slice(0, limit);

      return new Response(JSON.stringify({
        success: true,
        listings: deals,
        count: deals.length
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Default: Get published listings
    // Query just by status (no orderBy to avoid needing composite index)
    let listings: any[];

    if (collectionId) {
      // Filter by seller - just query by sellerId (single field)
      listings = await saQueryCollection(serviceAccountKey, projectId, 'vinylListings', {
        filters: [
          { field: 'sellerId', op: 'EQUAL', value: collectionId }
        ],
        limit: 200
      });
      // Then filter for published status client-side
      listings = listings.filter((l: any) => l.status === 'published');
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
    listings.sort((a: any, b: any) => {
      const dateA = new Date(a.publishedAt || a.createdAt).getTime();
      const dateB = new Date(b.publishedAt || b.createdAt).getTime();
      return dateB - dateA;
    });

    // Client-side filter for genre (Firebase doesn't support multiple field filters easily)
    let filteredListings = listings;
    if (genre && genre !== 'all') {
      filteredListings = listings.filter((l: any) => l.genre === genre);
    }

    // Get unique genres for filter
    const genres = [...new Set(listings.map((l: any) => l.genre).filter(Boolean))];

    return new Response(JSON.stringify({
      success: true,
      listings: filteredListings,
      count: filteredListings.length,
      genres
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[vinyl/public GET] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Failed to fetch data' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
