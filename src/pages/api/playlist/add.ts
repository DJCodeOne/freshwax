// src/pages/api/playlist/add.ts
// Add URL to user's playlist - requires authentication
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, setDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { parseMediaUrl, sanitizeUrl } from '../../../lib/url-parser';
import { parseJsonBody, ApiErrors, fetchWithTimeout, createLogger, successResponse } from '../../../lib/api-utils';
import { TIMEOUTS } from '../../../lib/timeouts';

const log = createLogger('playlist/add');
import type { UserPlaylist, PlaylistItem, MediaPlatform } from '../../../lib/types';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

const PlaylistAddSchema = z.object({
  url: z.string().min(1).max(2000),
}).strip();

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
    const response = await fetchWithTimeout(`https://noembed.com/embed?url=${encodeURIComponent(url)}`, {}, TIMEOUTS.OEMBED);
    if (!response.ok) return {};

    // SECURITY: Reject oversized responses to prevent DoS
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > 100000) return {};

    const data = await response.json();
    return {
      title: data.title || undefined,
      thumbnail: data.thumbnail_url || undefined
    };
  } catch (error: unknown) {
    log.warn('[playlist/add] Failed to fetch metadata:', error);
    return {};
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`playlist-add:${clientId}`, RateLimiters.standard);
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

    const rawBody = await request.json();
    const parseResult = PlaylistAddSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    // Use authenticated user's ID - ignore any userId in body
    const userId = authenticatedUserId;
    const { url } = parseResult.data;

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

    return successResponse({ message: 'Added to queue',
      item: newItem,
      queueSize: updatedQueue.length });

  } catch (error: unknown) {
    log.error('[playlist/add] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to add to playlist');
  }
};
