// src/pages/api/get-user-ratings.ts
// Get the logged-in user's ratings for specified releases
// D1 is PRIMARY - Firebase only used as last resort fallback

import type { APIRoute } from 'astro';
import { getDocument, initFirebaseEnv, verifyRequestUser } from '../../lib/firebase-rest';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
  const db = env?.DB;

  try {
    // Verify user is logged in (uses Firebase Auth but that's just token verification)
    initFirebaseEnv({
      FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
      FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
    });

    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Not authenticated'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = await request.json();
    const { releaseIds } = body;

    if (!releaseIds || !Array.isArray(releaseIds) || releaseIds.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'releaseIds array required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Limit to 50 releases per request
    const limitedIds = releaseIds.slice(0, 50);
    const userRatings: Record<string, number> = {};

    log.info('[get-user-ratings] Fetching ratings for user:', userId, 'releases:', limitedIds.length);

    // D1 is PRIMARY - use batch query for efficiency
    if (db) {
      try {
        // Build batch query with placeholders
        const placeholders = limitedIds.map(() => '?').join(',');
        const query = `SELECT release_id, rating FROM user_ratings WHERE user_id = ? AND release_id IN (${placeholders})`;
        const params = [userId, ...limitedIds];

        const result = await db.prepare(query).bind(...params).all();

        if (result?.results) {
          for (const row of result.results as any[]) {
            userRatings[row.release_id] = row.rating;
          }
        }

        log.info('[get-user-ratings] D1 found:', Object.keys(userRatings).length, 'ratings');

        // Return immediately - no Firebase needed
        return new Response(JSON.stringify({
          success: true,
          userRatings,
          source: 'd1'
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'private, max-age=60'
          }
        });
      } catch (d1Error) {
        log.error('[get-user-ratings] D1 error:', d1Error);
        // Only fall through to Firebase if D1 completely fails
      }
    }

    // FALLBACK ONLY: Firebase - only used if D1 is unavailable
    // This is expensive on quota, so we minimize usage
    log.info('[get-user-ratings] D1 unavailable, falling back to Firebase');

    for (const releaseId of limitedIds) {
      try {
        const release = await getDocument('releases', releaseId);
        if (release?.ratings?.userRatings?.[userId]) {
          userRatings[releaseId] = release.ratings.userRatings[userId];
        }
      } catch (e) {
        // Skip failed fetches
      }
    }

    log.info('[get-user-ratings] Firebase found:', Object.keys(userRatings).length, 'ratings');

    return new Response(JSON.stringify({
      success: true,
      userRatings,
      source: 'firebase'
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=60'
      }
    });

  } catch (error) {
    log.error('[get-user-ratings] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch user ratings'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
