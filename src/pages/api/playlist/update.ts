// src/pages/api/playlist/update.ts
// Update playlist state (currentIndex, isPlaying, etc.)
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { parseJsonBody, ApiErrors } from '../../../lib/api-utils';
import type { UserPlaylist } from '../../../lib/types';

const PlaylistUpdateSchema = z.object({
  currentIndex: z.number().int().min(0).nullish(),
  isPlaying: z.boolean().nullish(),
}).passthrough();

export const prerender = false;

export const PUT: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;

  try {
    // SECURITY: Get userId from verified token, not request body
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return ApiErrors.unauthorized('Authentication required');
    }

    // Get update params from body (safe since userId comes from token)
    const rawBody = await request.json();
    const parseResult = PlaylistUpdateSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { currentIndex, isPlaying } = parseResult.data;

    // Get current playlist to validate
    const existingPlaylist = await getDocument('userPlaylists', userId) as UserPlaylist | null;

    if (!existingPlaylist) {
      return ApiErrors.notFound('Playlist not found');
    }

    // Prepare update data
    const updates: Partial<UserPlaylist> = {
      lastUpdated: new Date().toISOString()
    };

    // Validate and add currentIndex if provided
    if (typeof currentIndex === 'number') {
      if (currentIndex < 0 || currentIndex >= existingPlaylist.queue.length) {
        return ApiErrors.badRequest('Invalid currentIndex');
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

  } catch (error: unknown) {
    console.error('[playlist/update] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to update playlist');
  }
};
