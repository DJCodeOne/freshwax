// src/pages/api/get-ratings.ts
// Uses D1 first, Firebase fallback
import type { APIRoute } from 'astro';
import { getDocument, initFirebaseEnv } from '../../lib/firebase-rest';
import { d1GetRatings } from '../../lib/d1-catalog';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
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
      return new Response(JSON.stringify({
        success: false,
        error: 'Release ID required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    log.info('[get-ratings] Fetching ratings for:', releaseId);

    // Try D1 first
    if (db) {
      try {
        const ratings = await d1GetRatings(db, releaseId);
        if (ratings) {
          log.info('[get-ratings] D1:', ratings);
          return new Response(JSON.stringify({
            success: true,
            average: ratings.average,
            count: ratings.count,
            fiveStarCount: ratings.fiveStarCount,
            source: 'd1'
          }), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'public, max-age=60, s-maxage=60'
            }
          });
        }
      } catch (d1Error) {
        log.error('[get-ratings] D1 error, falling back to Firebase:', d1Error);
      }
    }

    // Fallback to Firebase
    const release = await getDocument('releases', releaseId);

    if (!release) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Release not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const ratings = release.ratings || { average: 0, count: 0, fiveStarCount: 0 };

    log.info('[get-ratings] Firebase:', ratings);

    return new Response(JSON.stringify({
      success: true,
      average: ratings.average || 0,
      count: ratings.count || 0,
      fiveStarCount: ratings.fiveStarCount || 0,
      source: 'firebase'
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60, s-maxage=60'
      }
    });

  } catch (error) {
    log.error('[get-ratings] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch ratings'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};