// src/pages/api/youtube/duration.ts
// API endpoint to get YouTube video duration using oEmbed + fallback to player check

import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { fetchWithTimeout, ApiErrors, createLogger } from '../../../lib/api-utils';

const log = createLogger('youtube/duration');

export const prerender = false;

// Parse ISO 8601 duration (PT#M#S format) to seconds
function parseISO8601Duration(duration: string): number | null {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;

  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);

  return hours * 3600 + minutes * 60 + seconds;
}

export const GET: APIRoute = async ({ request, url }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`youtube-duration:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const videoId = url.searchParams.get('videoId');

  if (!videoId) {
    return ApiErrors.badRequest('Missing videoId parameter');
  }

  // Validate video ID format (11 characters, alphanumeric + dash/underscore)
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return ApiErrors.badRequest('Invalid video ID format');
  }

  try {
    // Method 1: Try YouTube Data API if we have an API key
    const youtubeApiKey = import.meta.env.YOUTUBE_API_KEY;

    if (youtubeApiKey) {
      const apiUrl = `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=contentDetails&key=${youtubeApiKey}`;
      const apiResponse = await fetchWithTimeout(apiUrl, {}, 10000);

      if (apiResponse.ok) {
        const data = await apiResponse.json();
        if (data.items && data.items.length > 0) {
          const duration = data.items[0].contentDetails?.duration;
          if (duration) {
            const seconds = parseISO8601Duration(duration);
            if (seconds !== null) {
              return successResponse({ duration: seconds,
                source: 'youtube-api' });
            }
          }
        }
      }
    }

    // Method 2: Try noembed.com (sometimes has duration)
    try {
      const noembedUrl = `https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`;
      const noembedResponse = await fetchWithTimeout(noembedUrl, {}, 5000);

      if (noembedResponse.ok) {
        const data = await noembedResponse.json();
        if (data.duration) {
          return successResponse({ duration: data.duration,
            source: 'noembed' });
        }
      }
    } catch (e: unknown) {
      // noembed failed, continue
    }

    // Method 3: Duration not available without API key
    // Return null to indicate we couldn't get the duration
    return successResponse({ duration: null,
      source: 'unavailable',
      message: 'Duration check requires YouTube API key' });

  } catch (error: unknown) {
    log.error('[youtube/duration] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to fetch duration');
  }
};
