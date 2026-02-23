// src/pages/api/rate-release.ts
// Uses Firebase as source of truth, dual-writes to D1

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, clearCache } from '../../lib/firebase-rest';
import { d1UpsertRating } from '../../lib/d1-catalog';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { kvDelete, CACHE_CONFIG } from '../../lib/kv-cache';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';

const RateReleaseSchema = z.object({
  releaseId: z.string().min(1, 'Release ID is required').max(200),
  rating: z.number().int().min(1).max(5),
});

const log = createLogger('rate-release');

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`rate-release:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;
  const db = env?.DB;

  try {
    // SECURITY: Get userId from verified token, not request body
    const { verifyRequestUser } = await import('../../lib/firebase-rest');
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return ApiErrors.unauthorized('You must be logged in to rate releases');
    }

    const body = await request.json();
    const parsed = RateReleaseSchema.safeParse(body);
    if (!parsed.success) {
      log.info('[rate-release] Validation failed:', parsed.error.issues);
      return ApiErrors.badRequest('Invalid request');
    }
    const { releaseId, rating } = parsed.data;

    log.info('[rate-release] Received:', releaseId, 'rating:', rating, 'user:', userId);

    // Get release from Firebase
    const releaseData = await getDocument('releases', releaseId);

    if (!releaseData) {
      log.info('[rate-release] Release not found:', releaseId);
      return ApiErrors.notFound('Release not found');
    }

    // Initialize ratings structure if needed
    if (!releaseData.ratings) {
      releaseData.ratings = {
        average: 0,
        count: 0,
        fiveStarCount: 0,
        userRatings: {}
      };
    }

    if (!releaseData.ratings.userRatings) {
      releaseData.ratings.userRatings = {};
    }

    const existingRating = releaseData.ratings.userRatings[userId];

    if (existingRating) {
      // Update existing rating
      log.info('[rate-release] Updating existing rating for user:', userId);

      const currentAverage = releaseData.ratings.average || 0;
      const ratingsCount = releaseData.ratings.count || 0;
      const fiveStarCount = releaseData.ratings.fiveStarCount || 0;

      // Remove old rating from total
      const totalRating = (currentAverage * ratingsCount) - existingRating;

      // Add new rating
      const newAverageRating = (totalRating + rating) / ratingsCount;
      const newFiveStarCount = fiveStarCount - (existingRating === 5 ? 1 : 0) + (rating === 5 ? 1 : 0);

      releaseData.ratings.average = parseFloat(newAverageRating.toFixed(2));
      releaseData.ratings.fiveStarCount = newFiveStarCount;
      releaseData.ratings.userRatings[userId] = rating;
      
    } else {
      // New rating
      log.info('[rate-release] Adding new rating for user:', userId);
      
      const currentAverage = releaseData.ratings.average || 0;
      const ratingsCount = releaseData.ratings.count || 0;
      const fiveStarCount = releaseData.ratings.fiveStarCount || 0;
      
      const totalRating = currentAverage * ratingsCount;
      const newRatingsCount = ratingsCount + 1;
      const newAverageRating = (totalRating + rating) / newRatingsCount;
      const newFiveStarCount = rating === 5 ? fiveStarCount + 1 : fiveStarCount;
      
      releaseData.ratings.average = parseFloat(newAverageRating.toFixed(2));
      releaseData.ratings.count = newRatingsCount;
      releaseData.ratings.fiveStarCount = newFiveStarCount;
      
      if (!releaseData.ratings.userRatings) {
        releaseData.ratings.userRatings = {};
      }
      releaseData.ratings.userRatings[userId] = rating;
    }

    releaseData.ratings.lastRatedAt = new Date().toISOString();
    releaseData.updatedAt = new Date().toISOString();

    log.info('[rate-release] Updated:', releaseData.ratings.average, 'avg,', releaseData.ratings.count, 'count');

    // Save to Firebase - update both ratings and overallRating for backward compatibility
    await updateDocument('releases', releaseId, {
      ratings: releaseData.ratings,
      overallRating: {
        average: releaseData.ratings.average,
        count: releaseData.ratings.count,
        total: releaseData.ratings.count, // total same as count
        fiveStarCount: releaseData.ratings.fiveStarCount
      },
      updatedAt: releaseData.updatedAt
    });

    log.info('[rate-release] Saved to Firebase');

    // Dual-write to D1 (non-blocking)
    if (db) {
      try {
        await d1UpsertRating(db, releaseId, userId, rating);
        log.info('[rate-release] Also written to D1');
      } catch (d1Error: unknown) {
        log.error('[rate-release] D1 dual-write failed (non-critical):', d1Error);
      }
    }

    // Invalidate cache for this release so fresh data is served
    clearCache(`releases:${releaseId}`);
    clearCache(`doc:releases:${releaseId}`);

    // Invalidate KV cache for releases list so all edge workers serve fresh data
    await kvDelete('live-releases-v2:20', CACHE_CONFIG.RELEASES).catch(() => {});
    await kvDelete('live-releases-v2:all', CACHE_CONFIG.RELEASES).catch(() => {});

    return successResponse({ newRating: releaseData.ratings.average,
      ratingsCount: releaseData.ratings.count,
      fiveStarCount: releaseData.ratings.fiveStarCount }, 200, { headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' } });

  } catch (error: unknown) {
    log.error('[rate-release] Error:', error);
    return ApiErrors.serverError('Failed to save rating');
  }
};