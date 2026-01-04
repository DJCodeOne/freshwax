// src/pages/api/get-releases-batch.ts
// Batch fetch release details for multiple releases in a single API call
// Reduces Firebase reads significantly by batching and caching

import type { APIRoute } from 'astro';
import { getDocumentsBatch, CACHE_TTL, initFirebaseEnv } from '../../lib/firebase-rest';

export const prerender = false;

// Simple in-memory cache for API responses
const responseCache = new Map<string, { data: any; expires: number }>();
const RESPONSE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes (releases don't change often)

function getCachedResponse(key: string): any | null {
  const entry = responseCache.get(key);
  if (entry && Date.now() < entry.expires) {
    return entry.data;
  }
  if (entry) {
    responseCache.delete(key);
  }
  return null;
}

function setCachedResponse(key: string, data: any): void {
  responseCache.set(key, {
    data,
    expires: Date.now() + RESPONSE_CACHE_TTL
  });

  // Cleanup if cache grows too large
  if (responseCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of responseCache) {
      if (now >= v.expires) {
        responseCache.delete(k);
      }
    }
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const body = await request.json();
    const { releaseIds, fields } = body;

    if (!releaseIds || !Array.isArray(releaseIds)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'releaseIds array required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Limit batch size to prevent abuse
    const limitedIds = releaseIds.slice(0, 50);

    // Check response cache first
    const cacheKey = `releases:${limitedIds.sort().join(',')}`;
    const cached = getCachedResponse(cacheKey);
    if (cached) {
      return new Response(JSON.stringify({
        success: true,
        releases: cached,
        source: 'cache'
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=600'
        }
      });
    }

    // Fetch releases in batch (much more efficient than individual reads)
    const releasesMap = await getDocumentsBatch('releases', limitedIds, CACHE_TTL.RELEASES_LIST);

    // Convert to array and filter out sensitive data
    const releases: Record<string, any> = {};

    for (const releaseId of limitedIds) {
      const release = releasesMap.get(releaseId);
      if (release) {
        // Return safe public data only
        releases[releaseId] = {
          id: release.id,
          title: release.title,
          artistName: release.artistName,
          artistId: release.artistId,
          price: release.price,
          salePrice: release.salePrice,
          onSale: release.onSale,
          coverArtUrl: release.coverArtUrl,
          thumbUrl: release.thumbUrl,
          genre: release.genre,
          releaseDate: release.releaseDate,
          format: release.format,
          trackCount: release.tracks?.length || 0,
          ratings: release.ratings,
          isFree: release.isFree,
          isHidden: release.isHidden,
          // Include tracks if requested (without download URLs)
          tracks: fields?.includes('tracks') ? release.tracks?.map((t: any) => ({
            title: t.title,
            duration: t.duration,
            trackNumber: t.trackNumber,
            bpm: t.bpm,
            key: t.key,
            previewUrl: t.previewUrl
          })) : undefined
        };
      }
    }

    // Cache the response
    setCachedResponse(cacheKey, releases);

    return new Response(JSON.stringify({
      success: true,
      releases,
      source: 'firestore'
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=600'
      }
    });

  } catch (error) {
    console.error('[get-releases-batch] Error:', error);

    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch releases',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// Also support GET with query params for simpler usage
export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const idsParam = url.searchParams.get('ids');

  if (!idsParam) {
    return new Response(JSON.stringify({
      success: false,
      error: 'ids query parameter required (comma-separated)'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const releaseIds = idsParam.split(',').map(id => id.trim()).filter(Boolean);

  if (releaseIds.length === 0) {
    return new Response(JSON.stringify({
      success: false,
      error: 'No valid release IDs provided'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Reuse POST logic
  const syntheticRequest = new Request(request.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ releaseIds })
  });

  return POST({ request: syntheticRequest, locals } as any);
};
