// src/pages/api/follow-artist.ts
// Follow/unfollow artists API - uses Firebase REST API
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, queryCollection, arrayUnion, arrayRemove } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger } from '../../lib/api-utils';

const log = createLogger('follow-artist');

const FollowArtistSchema = z.object({
  artistName: z.string().min(1).max(200).optional(),
  artistId: z.string().min(1).max(200).optional(),
  action: z.enum(['follow', 'unfollow', 'toggle', 'check']),
}).refine(data => data.artistName || data.artistId, {
  message: 'Either artistName or artistId is required',
});

export const GET: APIRoute = async ({ request, url, locals }) => {
  // Rate limit: standard - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`follow-artist-get:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }
  // Initialize Firebase from runtime env
  const env = locals.runtime.env;


  try {
    // SECURITY: Verify auth token
    const { verifyRequestUser } = await import('../../lib/firebase-rest');
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return ApiErrors.unauthorized('Authentication required');
    }

    // Get user's followed artists
    const customerDoc = await getDocument('users', userId);
    const followedArtists = customerDoc?.followedArtists || [];

    // If has followed artists, fetch their info
    if (followedArtists.length > 0) {
      const artistsData: any[] = [];

      // Get artist info from releases (grouped by artistName)
      // Note: releases use status 'live' not 'approved'
      const releases = await queryCollection('releases', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
        limit: 500
      });

      // Build a map of artists and their release counts
      const artistMap = new Map<string, any>();

      releases.forEach((release: any) => {
        const artistName = release.artistName;
        const artistId = release.artistId || release.submittedBy;

        if (followedArtists.includes(artistName) || followedArtists.includes(artistId)) {
          const key = artistName || artistId;
          if (!artistMap.has(key)) {
            artistMap.set(key, {
              id: artistId || key,
              artistName: artistName,
              releaseCount: 0,
              latestRelease: null,
              latestReleaseDate: null,
              coverArtUrl: release.coverArtUrl
            });
          }

          const artist = artistMap.get(key);
          artist.releaseCount++;

          // Track latest release
          const releaseDate = release.releaseDate || release.publishedAt || release.createdAt;
          if (!artist.latestReleaseDate || releaseDate > artist.latestReleaseDate) {
            artist.latestReleaseDate = releaseDate;
            artist.latestRelease = {
              id: release.id,
              releaseName: release.releaseName,
              coverArtUrl: release.coverArtUrl
            };
            artist.coverArtUrl = release.coverArtUrl;
          }
        }
      });

      // Convert map to array
      artistMap.forEach(artist => {
        artistsData.push(artist);
      });

      // Sort by latest release date
      artistsData.sort((a, b) => {
        const dateA = a.latestReleaseDate || '';
        const dateB = b.latestReleaseDate || '';
        return dateB.localeCompare(dateA);
      });

      // Return actual found artists count (not stored artist names count)
      return new Response(JSON.stringify({
        success: true,
        followedArtists: artistsData,
        count: artistsData.length,
        storedCount: followedArtists.length // For debugging - shows if some artists have no releases
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      followedArtists: [],
      count: 0,
      storedCount: 0
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    log.error('[FOLLOW API] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to get followed artists');
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`follow-artist-post:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // Initialize Firebase from runtime env
  const env = locals.runtime.env;


  try {
    // SECURITY: Get userId from verified token, not request body
    const { verifyRequestUser } = await import('../../lib/firebase-rest');
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return ApiErrors.unauthorized('Authentication required');
    }

    const body = await request.json();
    const parsed = FollowArtistSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { artistName, artistId, action } = parsed.data;

    // Use artistName as the primary identifier, fall back to artistId
    const artistIdentifier = artistName || artistId!;

    const now = new Date().toISOString();

    if (action === 'follow') {
      // Atomic arrayUnion prevents lost follows under concurrent writes
      await arrayUnion('users', userId, 'followedArtists', [artistIdentifier], {
        followedArtistsUpdatedAt: now
      });

      return new Response(JSON.stringify({
        success: true,
        message: 'Now following artist',
        isFollowing: true
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } else if (action === 'unfollow') {
      // Atomic arrayRemove prevents lost data under concurrent writes
      await arrayRemove('users', userId, 'followedArtists', [artistIdentifier], {
        followedArtistsUpdatedAt: now
      });

      return new Response(JSON.stringify({
        success: true,
        message: 'Unfollowed artist',
        isFollowing: false
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } else if (action === 'toggle') {
      // Read to determine current state, then use atomic operation for the mutation
      const customerDoc = await getDocument('users', userId);
      const currentFollowed = customerDoc?.followedArtists || [];
      const isFollowing = currentFollowed.includes(artistIdentifier);

      if (isFollowing) {
        await arrayRemove('users', userId, 'followedArtists', [artistIdentifier], {
          followedArtistsUpdatedAt: now
        });
        return new Response(JSON.stringify({
          success: true,
          message: 'Unfollowed artist',
          isFollowing: false
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } else {
        await arrayUnion('users', userId, 'followedArtists', [artistIdentifier], {
          followedArtistsUpdatedAt: now
        });
        return new Response(JSON.stringify({
          success: true,
          message: 'Now following artist',
          isFollowing: true
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

    } else if (action === 'check') {
      const customerDoc = await getDocument('users', userId);
      const currentFollowed = customerDoc?.followedArtists || [];
      const isFollowing = currentFollowed.includes(artistIdentifier);

      return new Response(JSON.stringify({
        success: true,
        isFollowing: isFollowing
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return ApiErrors.badRequest('Invalid action. Use: follow, unfollow, toggle, or check');

  } catch (error: unknown) {
    log.error('[FOLLOW API] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to update follow status');
  }
};
