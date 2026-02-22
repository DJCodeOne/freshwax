// src/pages/api/get-ratings-batch.ts
// Batch fetch ratings for multiple releases in a single API call
// Reduces Firebase reads significantly by batching and caching

import type { APIRoute } from 'astro';
import { getDocumentsBatch, CACHE_TTL } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger } from '../../lib/api-utils';

const log = createLogger('get-ratings-batch');
import { z } from 'zod';

const GetRatingsBatchSchema = z.object({
  releaseIds: z.array(z.string().max(200)).min(1).max(50),
}).passthrough();

export const prerender = false;

// Simple in-memory cache for API responses
const responseCache = new Map<string, { data: Record<string, { average: number; count: number; fiveStarCount: number }>; expires: number }>();
const RESPONSE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedResponse(key: string): Record<string, { average: number; count: number; fiveStarCount: number }> | null {
  const entry = responseCache.get(key);
  if (entry && Date.now() < entry.expires) {
    return entry.data;
  }
  if (entry) {
    responseCache.delete(key);
  }
  return null;
}

function setCachedResponse(key: string, data: Record<string, { average: number; count: number; fiveStarCount: number }>): void {
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
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`get-ratings-batch:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;

  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return ApiErrors.badRequest('Invalid JSON body');
    }

    const parseResult = GetRatingsBatchSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { releaseIds } = parseResult.data;

    // Limit batch size to prevent abuse
    const limitedIds = releaseIds.slice(0, 50);
    
    // Check response cache first
    const cacheKey = `ratings:${limitedIds.sort().join(',')}`;
    const cached = getCachedResponse(cacheKey);
    if (cached) {
      return successResponse({ ratings: cached,
        source: 'cache' }, 200, { headers: { 'Cache-Control': 'public, max-age=300' } });
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
    
    return successResponse({ ratings,
      source: 'firestore' }, 200, { headers: { 'Cache-Control': 'public, max-age=300' } });
    
  } catch (error: unknown) {
    log.error('[get-ratings-batch] Error:', error);
    
    return ApiErrors.serverError('Failed to fetch ratings');
  }
};

// Also support GET with query params for simpler usage
export const GET: APIRoute = async ({ request }) => {
  // Rate limit: standard API - 60 per minute
  const clientId2 = getClientId(request);
  const rateLimit2 = checkRateLimit(`get-ratings-batch-get:${clientId2}`, RateLimiters.standard);
  if (!rateLimit2.allowed) {
    return rateLimitResponse(rateLimit2.retryAfter!);
  }

  const url = new URL(request.url);
  const idsParam = url.searchParams.get('ids');
  
  if (!idsParam) {
    return ApiErrors.badRequest('ids query parameter required (comma-separated)');
  }
  
  const releaseIds = idsParam.split(',').map(id => id.trim()).filter(Boolean);
  
  if (releaseIds.length === 0) {
    return ApiErrors.badRequest('No valid release IDs provided');
  }
  
  // Reuse POST logic
  const syntheticRequest = new Request(request.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ releaseIds })
  });
  
  return POST({ request: syntheticRequest } as Parameters<typeof POST>[0]);
};
