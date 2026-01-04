// src/pages/api/playlist/remove.ts
// Remove item from user's playlist
import type { APIRoute } from 'astro';
import { getDocument, setDocument, initFirebaseEnv, verifyRequestUser } from '../../../lib/firebase-rest';
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

    // Get itemId from body (safe since we verify userId from token)
    const body = await parseJsonBody<{ itemId: string }>(request);
    const itemId = body?.itemId;

    if (!itemId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Item ID required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get current playlist
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

    // Remove item from queue
    const updatedQueue = existingPlaylist.queue.filter(item => item.id !== itemId);

    if (updatedQueue.length === existingPlaylist.queue.length) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Item not found in queue'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Adjust currentIndex if needed
    let newIndex = existingPlaylist.currentIndex;
    const removedIndex = existingPlaylist.queue.findIndex(item => item.id === itemId);

    if (removedIndex !== -1 && removedIndex < existingPlaylist.currentIndex) {
      newIndex = Math.max(0, newIndex - 1);
    } else if (removedIndex === existingPlaylist.currentIndex && updatedQueue.length > 0) {
      newIndex = Math.min(newIndex, updatedQueue.length - 1);
    } else if (updatedQueue.length === 0) {
      newIndex = 0;
    }

    // Update playlist
    const updatedPlaylist: UserPlaylist = {
      userId,
      queue: updatedQueue,
      currentIndex: newIndex,
      isPlaying: updatedQueue.length > 0 ? existingPlaylist.isPlaying : false,
      lastUpdated: new Date().toISOString()
    };

    await setDocument('userPlaylists', userId, updatedPlaylist);

    return new Response(JSON.stringify({
      success: true,
      message: 'Removed from queue',
      queueSize: updatedQueue.length
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[playlist/remove] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to remove from playlist'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
