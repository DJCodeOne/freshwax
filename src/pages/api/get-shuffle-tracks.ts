// src/pages/api/get-shuffle-tracks.ts
import type { APIRoute } from 'astro';
import { getLiveReleases, extractTracksFromReleases, shuffleArray } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger, jsonResponse, successResponse } from '../../lib/api-utils';

const logger = createLogger('get-shuffle-tracks');

export const prerender = false;

let pendingRequest: Promise<Record<string, unknown>> | null = null;
let lastFetchTime = 0;
const CACHE_DURATION = 5 * 60 * 1000;
let cachedResult: { tracks: unknown[]; meta: Record<string, unknown> } | null = null;

export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`get-shuffle-tracks:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // Initialize Firebase for Cloudflare runtime
  const env = locals.runtime.env;

  const startTime = Date.now();
  
  try {
    if (cachedResult && (Date.now() - lastFetchTime) < CACHE_DURATION) {
      logger.info('[get-shuffle-tracks] Returning cached result');
      
      const reshuffled = shuffleArray([...cachedResult.tracks]).slice(0, 30);
      
      return successResponse({ tracks: reshuffled,
        meta: {
          ...cachedResult.meta,
          cached: true,
          reshuffled: true
        } }, 200, { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=300' } });
    }
    
    if (pendingRequest) {
      logger.info('[get-shuffle-tracks] Waiting for pending request');
      const result = await pendingRequest;
      return jsonResponse(result);
    }
    
    pendingRequest = (async () => {
      logger.info('[get-shuffle-tracks] Fetching fresh data');

      const releases = await getLiveReleases(50);
      const allTracks = extractTracksFromReleases(releases);
      
      cachedResult = {
        tracks: allTracks,
        meta: {
          total: allTracks.length,
          fetchTime: Date.now() - startTime
        }
      };
      lastFetchTime = Date.now();
      
      const shuffled = shuffleArray([...allTracks]).slice(0, 30);
      
      return {
        success: true,
        tracks: shuffled,
        meta: {
          total: allTracks.length,
          returned: shuffled.length,
          fetchTime: Date.now() - startTime,
          cached: false
        }
      };
    })();
    
    const result = await pendingRequest;
    pendingRequest = null;
    
    logger.info('[get-shuffle-tracks] Returning', result.tracks.length, 'tracks');
    
    return jsonResponse(result, 200, { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=300' } });
    
  } catch (error: unknown) {
    pendingRequest = null;
    logger.error('[get-shuffle-tracks] Error:', error instanceof Error ? error.message : String(error));
    
    if (cachedResult) {
      logger.info('[get-shuffle-tracks] Returning stale cache');
      const reshuffled = shuffleArray([...cachedResult.tracks]).slice(0, 30);
      return successResponse({ tracks: reshuffled,
        meta: { ...cachedResult.meta, stale: true } });
    }
    
    return ApiErrors.serverError('Failed to fetch tracks');
  }
};