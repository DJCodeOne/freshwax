// src/pages/api/playlist/add.ts
// Add URL to user's playlist - requires authentication
import type { APIRoute } from 'astro';
import { getDocument, setDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { parseMediaUrl, sanitizeUrl } from '../../../lib/url-parser';
import { parseJsonBody, ApiErrors } from '../../../lib/api-utils';
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
    const response = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(5000) // 5s timeout
    });
    if (!response.ok) return {};

    // SECURITY: Reject oversized responses to prevent DoS
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > 100000) return {};

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
  const env = locals.runtime.env;

  try {
    // Verify authentication
    const { userId: authenticatedUserId, error: authError } = await verifyRequestUser(request);
    if (!authenticatedUserId) {
      return ApiErrors.unauthorized(authError || 'Authentication required');
    }

    const body = await parseJsonBody<{ url: string }>(request);

    if (!body?.url) {
      return ApiErrors.badRequest('URL required');
    }

    // Use authenticated user's ID - ignore any userId in body
    const userId = authenticatedUserId;
    const { url } = body;

    // Sanitize and parse URL
    const sanitizedUrl = sanitizeUrl(url);
    if (!sanitizedUrl) {
      return ApiErrors.badRequest('Invalid URL - potential security issue detected');
    }

    const parsed = parseMediaUrl(sanitizedUrl);
    if (!parsed.isValid) {
      return ApiErrors.badRequest(parsed.error || 'Invalid or unsupported URL format');
    }

    // Get current playlist
    const existingPlaylist = await getDocument('userPlaylists', userId) as UserPlaylist | null;
    const currentQueue = existingPlaylist?.queue || [];

    // Check max queue size
    if (currentQueue.length >= MAX_QUEUE_SIZE) {
      return ApiErrors.badRequest('Queue is full (${MAX_QUEUE_SIZE} items max). Wait for the current track to end before trying again.');
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

  } catch (error: unknown) {
    console.error('[playlist/add] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to add to playlist');
  }
};
