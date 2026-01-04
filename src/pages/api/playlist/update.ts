// src/pages/api/playlist/update.ts
// Update playlist state (currentIndex, isPlaying, etc.)
import type { APIRoute } from 'astro';
import { getDocument, updateDocument, initFirebaseEnv, verifyRequestUser } from '../../../lib/firebase-rest';
import { parseJsonBody } from '../../../lib/api-utils';
import type { UserPlaylist } from '../../../lib/types';

export const prerender = false;

export const PUT: APIRoute = async ({ request, locals }) => {
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

    // Get update params from body (safe since userId comes from token)
    const body = await parseJsonBody<{
      currentIndex?: number;
      isPlaying?: boolean;
    }>(request);

    const { currentIndex, isPlaying } = body || {};

    // Get current playlist to validate
    const existingPlaylist = await getDocument('userPlaylists', userId) as UserPlaylist | null;

    if (!existingPlaylist) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Playlist not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Prepare update data
    const updates: Partial<UserPlaylist> = {
      lastUpdated: new Date().toISOString()
    };

    // Validate and add currentIndex if provided
    if (typeof currentIndex === 'number') {
      if (currentIndex < 0 || currentIndex >= existingPlaylist.queue.length) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid currentIndex'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      updates.currentIndex = currentIndex;
    }

    // Add isPlaying if provided
    if (typeof isPlaying === 'boolean') {
      updates.isPlaying = isPlaying;
    }

    // Update playlist
    await updateDocument('userPlaylists', userId, updates);

    return new Response(JSON.stringify({
      success: true,
      message: 'Playlist updated'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[playlist/update] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to update playlist'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
