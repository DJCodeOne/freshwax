// src/pages/api/playlist/server-list.ts
// Authenticated proxy for playlist.freshwax.co.uk/list
// Prevents unauthenticated inventory disclosure of 5,000+ MP3s

import type { APIRoute } from 'astro';
import { verifyRequestUser } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { errorResponse, ApiErrors } from '../../../lib/api-utils';

export const prerender = false;

const PLAYLIST_SERVER = 'https://playlist.freshwax.co.uk';

export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`playlist-server-list:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;


  // SECURITY: Require authentication
  const { userId, error: authError } = await verifyRequestUser(request);
  if (!userId || authError) {
    return ApiErrors.unauthorized('Authentication required');
  }

  try {
    const playlistToken = env?.PLAYLIST_ACCESS_TOKEN || import.meta.env.PLAYLIST_ACCESS_TOKEN || '';
    const response = await fetch(`${PLAYLIST_SERVER}/list`, {
      headers: { 'Authorization': `Bearer ${playlistToken}` },
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      return errorResponse('Playlist server unavailable', 502);
    }

    const data = await response.json();

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=300'
      }
    });
  } catch (error) {
    return errorResponse('Playlist server error', 502);
  }
};
