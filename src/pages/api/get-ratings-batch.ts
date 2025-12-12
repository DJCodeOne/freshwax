// src/pages/api/get-ratings-batch.ts
// Batch fetch ratings for multiple releases in a single API call
// Reduces Firebase reads significantly by batching and caching

import type { APIRoute } from 'astro';
import { getDocumentsBatch, CACHE_TTL } from '../../lib/firebase-rest';

export const prerender = false;

// Simple in-memory cache for API responses
const responseCache = new Map<string, { data: any; expires: number }>();
const RESPONSE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { releaseIds } = body;
    
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
    const cacheKey = `ratings:${limitedIds.sort().join(',')}`;
    const cached = getCachedResponse(cacheKey);
    if (cached) {
      return new Response(JSON.stringify({
        success: true,
        ratings: cached,
        source: 'cache'
      }), {
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300'
        }
      });
    }
    
    // Fetch releases in batch (much more efficient than individual reads)
    const releases = await getDocumentsBatch('releases', limitedIds, CACHE_TTL.RATINGS);
    
    // Extract ratings from releases
    const ratings: Record<string, { average: number; count: number; fiveStarCount: number }> = {};
    
    for (const releaseId of limitedIds) {
      const release = releases.get(releaseId);
      if (release) {
        ratings[releaseId] = {
          average: release.ratings?.average || 0,
          count: release.ratings?.count || 0,
          fiveStarCount: release.ratings?.fiveStarCount || 0
        };
      } else {
        // Release not found, return default
        ratings[releaseId] = { average: 0, count: 0, fiveStarCount: 0 };
      }
    }
    
    // Cache the response
    setCachedResponse(cacheKey, ratings);
    
    return new Response(JSON.stringify({
      success: true,
      ratings,
      source: 'firestore'
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300'
      }
    });
    
  } catch (error) {
    console.error('[get-ratings-batch] Error:', error);
    
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch ratings',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// Also support GET with query params for simpler usage
export const GET: APIRoute = async ({ request }) => {
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
  
  return POST({ request: syntheticRequest } as any);
};
