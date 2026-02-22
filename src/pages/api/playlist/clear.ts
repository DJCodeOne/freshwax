// src/pages/api/playlist/clear.ts
// Clear user's playlist queue
import type { APIRoute } from 'astro';
import { setDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import type { UserPlaylist } from '../../../lib/types';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('playlist/clear');

export const prerender = false;

export const DELETE: APIRoute = async ({ request, locals }) => {
  // Rate limit: playlist operations - 30 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`playlist-clear:${clientId}`, RateLimiters.write);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;

  try {
    // SECURITY: Get userId from verified token, not request body
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return ApiErrors.unauthorized('Authentication required');
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

    return successResponse({ message: 'Playlist cleared' });

  } catch (error: unknown) {
    log.error('[playlist/clear] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to clear playlist');
  }
};
