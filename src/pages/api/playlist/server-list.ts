// src/pages/api/playlist/server-list.ts
// Authenticated proxy for playlist.freshwax.co.uk/list
// Prevents unauthenticated inventory disclosure of 5,000+ MP3s

import type { APIRoute } from 'astro';
import { verifyRequestUser } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { errorResponse, ApiErrors, fetchWithTimeout } from '../../../lib/api-utils';

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
    const response = await fetchWithTimeout(`${PLAYLIST_SERVER}/list`, {
      headers: { 'Authorization': `Bearer ${playlistToken}` }
    }, 5000);

    if (!response.ok) {
      return errorResponse('Playlist server unavailable', 502);
    }

    const data = await response.json();

    return jsonResponse(data, 200, { headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch (error: unknown) {
    return errorResponse('Playlist server error', 502);
  }
};
