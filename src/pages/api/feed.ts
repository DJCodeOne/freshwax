// src/pages/api/feed.ts
// Activity feed API — GET /api/feed/?mode=global|personal&limit=20&before=cursor
import type { APIRoute } from 'astro';
import { getGlobalFeed, getPersonalizedFeed } from '../../lib/activity-feed';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

export const prerender = false;

const log = createLogger('api-feed');

export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard read — 60 per minute per IP
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`feed:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;
  const db = env?.DB;
  if (!db) {
    return ApiErrors.serverError('Database not available');
  }

  try {
    const url = new URL(request.url);
    const mode = url.searchParams.get('mode') || 'global';
    const limitParam = url.searchParams.get('limit');
    const before = url.searchParams.get('before') || undefined;
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 20, 1), 50) : 20;

    if (mode === 'personal') {
      // Personal feed requires authentication
      const { verifyRequestUser } = await import('../../lib/firebase-rest');
      const { userId, error: authError } = await verifyRequestUser(request);
      if (authError || !userId) {
        return ApiErrors.unauthorized('Authentication required for personal feed');
      }

      // Get user's followed artists for filtering
      let followedArtistIds: string[] = [];
      try {
        const { getDocument } = await import('../../lib/firebase-rest');
        const userDoc = await getDocument('users', userId);
        if (userDoc?.followedArtists && Array.isArray(userDoc.followedArtists)) {
          followedArtistIds = userDoc.followedArtists;
        }
      } catch (err: unknown) {
        log.error('Failed to fetch followed artists:', err instanceof Error ? err.message : err);
      }

      const feed = await getPersonalizedFeed(db, userId, followedArtistIds, { limit, before });
      return successResponse(feed, 200, {
        headers: { 'Cache-Control': 'private, no-cache' }
      });
    }

    // Global feed — public, cacheable for 30 seconds
    const feed = await getGlobalFeed(db, { limit, before });
    return successResponse(feed, 200, {
      headers: { 'Cache-Control': 'public, max-age=30, s-maxage=30, stale-while-revalidate=60' }
    });

  } catch (error: unknown) {
    log.error('Feed error:', error instanceof Error ? error.message : error);
    return ApiErrors.serverError('Failed to fetch activity feed');
  }
};
