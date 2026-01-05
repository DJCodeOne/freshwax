// src/pages/api/playlist/clear.ts
// Clear user's playlist queue
import type { APIRoute } from 'astro';
import { setDocument, initFirebaseEnv, verifyRequestUser } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import type { UserPlaylist } from '../../../lib/types';

export const prerender = false;

export const DELETE: APIRoute = async ({ request, locals }) => {
  // Rate limit: playlist operations - 30 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`playlist-clear:${clientId}`, RateLimiters.write);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY || import.meta.env.PUBLIC_FIREBASE_API_KEY,
  });

  try {
    // SECURITY: Get userId from verified token, not request body
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Authentication required'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Create empty playlist
    const emptyPlaylist: UserPlaylist = {
      userId,
      queue: [],
      currentIndex: 0,
      isPlaying: false,
      lastUpdated: new Date().toISOString()
    };

    await setDocument('userPlaylists', userId, emptyPlaylist);

    return new Response(JSON.stringify({
      success: true,
      message: 'Playlist cleared'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[playlist/clear] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to clear playlist'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
