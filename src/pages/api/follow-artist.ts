// src/pages/api/follow-artist.ts
// Follow/unfollow artists API - uses Firebase REST API
import type { APIRoute } from 'astro';
import { getDocument, setDocument, updateDocument, queryCollection , initFirebaseEnv } from '../../lib/firebase-rest';

export const GET: APIRoute = async ({ request, url }) => {
  try {
    const userId = url.searchParams.get('userId');

    if (!userId) {
      return new Response(JSON.stringify({ success: false, error: 'User ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get user's followed artists
    const customerDoc = await getDocument('customers', userId);
    const followedArtists = customerDoc?.followedArtists || [];

    // If has followed artists, fetch their info
    if (followedArtists.length > 0) {
      const artistsData: any[] = [];

      // Get artist info from releases (grouped by artistName)
      const releases = await queryCollection('releases', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'approved' }],
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

      return new Response(JSON.stringify({
        success: true,
        followedArtists: artistsData,
        count: followedArtists.length
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      followedArtists: [],
      count: 0
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[FOLLOW API] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to get followed artists'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { userId, artistName, artistId, action } = body;

    // Use artistName as the primary identifier, fall back to artistId
    const artistIdentifier = artistName || artistId;

    if (!userId || !artistIdentifier) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User ID and Artist name/ID required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const now = new Date().toISOString();

    if (action === 'follow') {
      // Get current followed artists and add new one
      const customerDoc = await getDocument('customers', userId);
      const currentFollowed = customerDoc?.followedArtists || [];

      if (!currentFollowed.includes(artistIdentifier)) {
        currentFollowed.push(artistIdentifier);
      }

      await setDocument('customers', userId, {
        ...customerDoc,
        followedArtists: currentFollowed,
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
      const customerDoc = await getDocument('customers', userId);
      const currentFollowed = customerDoc?.followedArtists || [];
      const newFollowed = currentFollowed.filter((a: string) => a !== artistIdentifier);

      await updateDocument('customers', userId, {
        followedArtists: newFollowed,
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
      const customerDoc = await getDocument('customers', userId);
      const currentFollowed = customerDoc?.followedArtists || [];
      const isFollowing = currentFollowed.includes(artistIdentifier);

      if (isFollowing) {
        const newFollowed = currentFollowed.filter((a: string) => a !== artistIdentifier);
        await updateDocument('customers', userId, {
          followedArtists: newFollowed,
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
        currentFollowed.push(artistIdentifier);
        await setDocument('customers', userId, {
          ...customerDoc,
          followedArtists: currentFollowed,
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
      const customerDoc = await getDocument('customers', userId);
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

    return new Response(JSON.stringify({
      success: false,
      error: 'Invalid action. Use: follow, unfollow, toggle, or check'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[FOLLOW API] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to update follow status'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
