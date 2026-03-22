// src/pages/api/youtube/title.ts
// Server-side API to fetch YouTube video title (avoids CORS issues)

import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, fetchWithTimeout, createLogger, successResponse } from '../../../lib/api-utils';
import { TIMEOUTS } from '../../../lib/timeouts';

const log = createLogger('youtube/title');

export const prerender = false;

export const GET: APIRoute = async ({ request, url }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`youtube-title:${clientId}`, RateLimiters.standard);
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
    // Use YouTube oEmbed API (no API key required)
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const response = await fetchWithTimeout(oembedUrl, {}, TIMEOUTS.SHORT);

    if (response.ok) {
      const data = await response.json();
      return successResponse({ title: data.title || null,
        author: data.author_name || null,
        thumbnail: data.thumbnail_url || null });
    }

    // If oEmbed fails, return null title
    return successResponse({ title: null,
      error: 'Could not fetch video info' });

  } catch (error: unknown) {
    log.error('[youtube/title] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to fetch title');
  }
};
