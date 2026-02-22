// src/pages/api/get-user-ratings.ts
// Get the logged-in user's ratings for specified releases
// D1 is PRIMARY - Firebase only used as last resort fallback

import type { APIRoute } from 'astro';
import { getDocument, verifyRequestUser } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';

interface D1RatingRow {
  release_id: string;
  rating: number;
}

const logger = createLogger('get-user-ratings');

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`get-user-ratings:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;
  const db = env?.DB;

  try {
    // Verify user is logged in (uses Firebase Auth but that's just token verification)


    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return ApiErrors.unauthorized('Not authenticated');
    }

    const body = await request.json();
    const { releaseIds } = body;

    if (!releaseIds || !Array.isArray(releaseIds) || releaseIds.length === 0) {
      return ApiErrors.badRequest('releaseIds array required');
    }

    // Limit to 50 releases per request
    const limitedIds = releaseIds.slice(0, 50);
    const userRatings: Record<string, number> = {};

    logger.info('[get-user-ratings] Fetching ratings for user:', userId, 'releases:', limitedIds.length);

    // D1 is PRIMARY - use batch query for efficiency
    if (db) {
      try {
        // Build batch query with placeholders
        const placeholders = limitedIds.map(() => '?').join(',');
        const query = `SELECT release_id, rating FROM user_ratings WHERE user_id = ? AND release_id IN (${placeholders})`;
        const params = [userId, ...limitedIds];

        const result = await db.prepare(query).bind(...params).all();

        if (result?.results) {
          for (const row of (result.results as unknown as D1RatingRow[])) {
            userRatings[row.release_id] = row.rating;
          }
        }

        logger.info('[get-user-ratings] D1 found:', Object.keys(userRatings).length, 'ratings');

        // If D1 found all ratings, return immediately
        if (Object.keys(userRatings).length === limitedIds.length) {
          return successResponse({ userRatings,
            source: 'd1' }, 200, { headers: { 'Cache-Control': 'private, max-age=60' } });
        }

        // D1 found some but not all - check Firebase for missing ones
        logger.info('[get-user-ratings] D1 missing some ratings, checking Firebase for remaining');
      } catch (d1Error: unknown) {
        logger.error('[get-user-ratings] D1 error:', d1Error);
        // Fall through to Firebase
      }
    }

    // FALLBACK: Firebase - check for ratings not found in D1
    // Only query releases we don't have ratings for yet
    const missingIds = limitedIds.filter(id => !userRatings[id]);

    if (missingIds.length > 0) {
      logger.info('[get-user-ratings] Checking Firebase for', missingIds.length, 'releases');

      for (const releaseId of missingIds) {
        try {
          const release = await getDocument('releases', releaseId);
          if (release?.ratings?.userRatings?.[userId]) {
            userRatings[releaseId] = release.ratings.userRatings[userId];
          }
        } catch (e: unknown) {
          // Skip failed fetches
        }
      }
    }

    const source = missingIds.length === limitedIds.length ? 'firebase' : 'mixed';
    logger.info('[get-user-ratings] Total found:', Object.keys(userRatings).length, 'ratings, source:', source);

    return successResponse({ userRatings,
      source }, 200, { headers: { 'Cache-Control': 'private, max-age=60' } });

  } catch (error: unknown) {
    logger.error('[get-user-ratings] Error:', error);
    return ApiErrors.serverError('Failed to fetch user ratings');
  }
};
