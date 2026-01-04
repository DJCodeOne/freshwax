// src/pages/api/playlist/add.ts
// Add URL to user's playlist - requires authentication
import type { APIRoute } from 'astro';
import { getDocument, setDocument, initFirebaseEnv, verifyRequestUser } from '../../../lib/firebase-rest';
import { parseMediaUrl, sanitizeUrl } from '../../../lib/url-parser';
import { parseJsonBody } from '../../../lib/api-utils';
import type { UserPlaylist, PlaylistItem, MediaPlatform } from '../../../lib/types';

export const prerender = false;

const MAX_QUEUE_SIZE = 10;

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

// Get thumbnail URL for a video
function getThumbnailUrl(platform: MediaPlatform, embedId?: string, url?: string): string {
  switch (platform) {
    case 'youtube':
      return embedId ? `https://img.youtube.com/vi/${embedId}/mqdefault.jpg` : '';
    case 'vimeo':
      // Vimeo thumbnails require API call, return placeholder
      return '';
    case 'soundcloud':
      // SoundCloud thumbnails require API call, return placeholder
      return '';
    case 'direct':
      return '';
    default:
      return '';
  }
}

// Fetch video metadata using noembed.com (free oEmbed proxy)
async function fetchVideoMetadata(url: string): Promise<{ title?: string; thumbnail?: string }> {
  try {
    const response = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`);
    if (!response.ok) return {};

    const data = await response.json();
    return {
      title: data.title || undefined,
      thumbnail: data.thumbnail_url || undefined
    };
  } catch (error) {
    console.warn('[playlist/add] Failed to fetch metadata:', error);
    return {};
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY || import.meta.env.PUBLIC_FIREBASE_API_KEY,
  });

  try {
    // Verify authentication
    const { userId: authenticatedUserId, error: authError } = await verifyRequestUser(request);
    if (!authenticatedUserId) {
      return new Response(JSON.stringify({
        success: false,
        error: authError || 'Authentication required'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = await parseJsonBody<{ url: string }>(request);

    if (!body?.url) {
      return new Response(JSON.stringify({
        success: false,
        error: 'URL required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Use authenticated user's ID - ignore any userId in body
    const userId = authenticatedUserId;
    const { url } = body;

    // Sanitize and parse URL
    const sanitizedUrl = sanitizeUrl(url);
    if (!sanitizedUrl) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid URL - potential security issue detected'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const parsed = parseMediaUrl(sanitizedUrl);
    if (!parsed.isValid) {
      return new Response(JSON.stringify({
        success: false,
        error: parsed.error || 'Invalid or unsupported URL format'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get current playlist
    const existingPlaylist = await getDocument('userPlaylists', userId) as UserPlaylist | null;
    const currentQueue = existingPlaylist?.queue || [];

    // Check max queue size
    if (currentQueue.length >= MAX_QUEUE_SIZE) {
      return new Response(JSON.stringify({
        success: false,
        error: `Queue is full (${MAX_QUEUE_SIZE} items max). Wait for the current track to end before trying again.`
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Fetch video metadata (title, thumbnail)
    const metadata = await fetchVideoMetadata(sanitizedUrl);

    // Get thumbnail - prefer oEmbed, fallback to direct URL construction
    const thumbnail = metadata.thumbnail || getThumbnailUrl(parsed.platform, parsed.embedId, sanitizedUrl);

    // Create new playlist item
    const newItem: PlaylistItem = {
      id: generateId(),
      url: sanitizedUrl,
      platform: parsed.platform,
      embedId: parsed.embedId,
      title: metadata.title,
      thumbnail: thumbnail || undefined,
      addedAt: new Date().toISOString()
    };

    // Add to queue
    const updatedQueue = [...currentQueue, newItem];

    // Update playlist
    const updatedPlaylist: UserPlaylist = {
      userId,
      queue: updatedQueue,
      currentIndex: existingPlaylist?.currentIndex || 0,
      isPlaying: existingPlaylist?.isPlaying || false,
      lastUpdated: new Date().toISOString()
    };

    await setDocument('userPlaylists', userId, updatedPlaylist);

    return new Response(JSON.stringify({
      success: true,
      message: 'Added to queue',
      item: newItem,
      queueSize: updatedQueue.length
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[playlist/add] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to add to playlist'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
