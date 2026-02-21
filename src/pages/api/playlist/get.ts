// src/pages/api/playlist/get.ts
// Get user's playlist - requires authentication
import type { APIRoute } from 'astro';
import { getDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import type { UserPlaylist } from '../../../lib/types';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger } from '../../../lib/api-utils';

const log = createLogger('playlist/get');

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`playlist-get:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;

  try {
    // Verify authentication
    const { userId: authenticatedUserId, error: authError } = await verifyRequestUser(request);
    if (!authenticatedUserId) {
      return ApiErrors.unauthorized(authError || 'Authentication required');
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

  } catch (error: unknown) {
    log.error('[playlist/get] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to get playlist');
  }
};
