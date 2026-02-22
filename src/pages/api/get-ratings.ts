// src/pages/api/get-ratings.ts
// Uses D1 first, Firebase fallback
import type { APIRoute } from 'astro';
import { getDocument, initFirebaseEnv } from '../../lib/firebase-rest';
import { d1GetRatings } from '../../lib/d1-catalog';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';

const logger = createLogger('get-ratings');

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`get-ratings:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;
  const db = env?.DB;

  // Initialize Firebase for fallback
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const url = new URL(request.url);
    const releaseId = url.searchParams.get('releaseId');

    if (!releaseId) {
      return ApiErrors.badRequest('Release ID required');
    }

    logger.info('[get-ratings] Fetching ratings for:', releaseId);

    // Try D1 first
    if (db) {
      try {
        const ratings = await d1GetRatings(db, releaseId);
        if (ratings) {
          logger.info('[get-ratings] D1:', ratings);
          return successResponse({ average: ratings.average,
            count: ratings.count,
            fiveStarCount: ratings.fiveStarCount,
            source: 'd1' }, 200, { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=60' } });
        }
      } catch (d1Error: unknown) {
        logger.error('[get-ratings] D1 error, falling back to Firebase:', d1Error);
      }
    }

    // Fallback to Firebase
    const release = await getDocument('releases', releaseId);

    if (!release) {
      return ApiErrors.notFound('Release not found');
    }

    const ratings = release.ratings || { average: 0, count: 0, fiveStarCount: 0 };

    logger.info('[get-ratings] Firebase:', ratings);

    return successResponse({ average: ratings.average || 0,
      count: ratings.count || 0,
      fiveStarCount: ratings.fiveStarCount || 0,
      source: 'firebase' }, 200, { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=60' } });

  } catch (error: unknown) {
    logger.error('[get-ratings] Error:', error);
    return ApiErrors.serverError('Failed to fetch ratings');
  }
};