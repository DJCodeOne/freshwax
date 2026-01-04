// src/pages/api/rate-release.ts
// Uses Firebase as source of truth

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, clearCache, initFirebaseEnv } from '../../lib/firebase-rest';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    // SECURITY: Get userId from verified token, not request body
    const { verifyRequestUser } = await import('../../lib/firebase-rest');
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'You must be logged in to rate releases'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = await request.json();
    const { releaseId, rating } = body;

    log.info('[rate-release] Received:', releaseId, 'rating:', rating, 'user:', userId);

    // Validate rating
    if (!releaseId || !rating || rating < 1 || rating > 5) {
      log.info('[rate-release] Invalid rating:', releaseId, rating);
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid rating (must be 1-5)'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get release from Firebase
    const releaseData: any = await getDocument('releases', releaseId);

    if (!releaseData) {
      log.info('[rate-release] Release not found:', releaseId);
      return new Response(JSON.stringify({
        success: false,
        error: 'Release not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
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

    const existingRating = releaseData.ratings.userRatings?.[userId];
    
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

    // Invalidate cache for this release so fresh data is served
    clearCache(`releases:${releaseId}`);
    clearCache(`doc:releases:${releaseId}`);

    return new Response(JSON.stringify({
      success: true,
      newRating: releaseData.ratings.average,
      ratingsCount: releaseData.ratings.count,
      fiveStarCount: releaseData.ratings.fiveStarCount
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      }
    });

  } catch (error) {
    log.error('[rate-release] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to save rating',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};