// src/pages/api/playlist/clear.ts
// Clear user's playlist queue
import type { APIRoute } from 'astro';
import { setDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { parseJsonBody } from '../../../lib/api-utils';
import type { UserPlaylist } from '../../../lib/types';

export const prerender = false;

export const DELETE: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY || import.meta.env.PUBLIC_FIREBASE_API_KEY,
  });

  try {
    const body = await parseJsonBody<{ userId: string }>(request);

    if (!body?.userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User ID required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { userId } = body;

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
