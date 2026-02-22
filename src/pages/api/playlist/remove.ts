// src/pages/api/playlist/remove.ts
// Remove item from user's playlist
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, setDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { parseJsonBody, ApiErrors, createLogger } from '../../../lib/api-utils';

const log = createLogger('playlist/remove');
import type { UserPlaylist } from '../../../lib/types';

const PlaylistRemoveSchema = z.object({
  itemId: z.string().min(1).max(500),
}).passthrough();

export const prerender = false;

export const DELETE: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;

  try {
    // SECURITY: Get userId from verified token, not request body
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return ApiErrors.unauthorized('Authentication required');
    }

    // Get itemId from body (safe since we verify userId from token)
    const rawBody = await request.json();
    const parseResult = PlaylistRemoveSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { itemId } = parseResult.data;

    // Get current playlist
    const existingPlaylist = await getDocument('userPlaylists', userId) as UserPlaylist | null;

    if (!existingPlaylist) {
      return ApiErrors.notFound('Playlist not found');
    }

    // Remove item from queue
    const updatedQueue = existingPlaylist.queue.filter(item => item.id !== itemId);

    if (updatedQueue.length === existingPlaylist.queue.length) {
      return ApiErrors.notFound('Item not found in queue');
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

    return successResponse({ message: 'Removed from queue',
      queueSize: updatedQueue.length });

  } catch (error: unknown) {
    log.error('[playlist/remove] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to remove from playlist');
  }
};
