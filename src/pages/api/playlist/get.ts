// src/pages/api/playlist/get.ts
// Get user's playlist - requires authentication
import type { APIRoute } from 'astro';
import { getDocument, initFirebaseEnv, verifyRequestUser } from '../../../lib/firebase-rest';
import type { UserPlaylist } from '../../../lib/types';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY || import.meta.env.PUBLIC_FIREBASE_API_KEY,
  });

  try {
    // Verify authentication
    const { userId: authenticatedUserId, error: authError } = await verifyRequestUser(request);
    if (!authenticatedUserId) {
      return new Response(JSON.stringify({
        success: false,
        error: authError || 'Authentication required'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Use authenticated user's ID - ignore any userId in query params
    const userId = authenticatedUserId;

    // Get playlist from Firestore
    const playlist = await getDocument('userPlaylists', userId) as UserPlaylist | null;

    if (!playlist) {
      // Return empty playlist if not found
      return new Response(JSON.stringify({
        success: true,
        playlist: {
          userId,
          queue: [],
          currentIndex: 0,
          isPlaying: false,
          lastUpdated: new Date().toISOString()
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      playlist
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[playlist/get] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to get playlist'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
