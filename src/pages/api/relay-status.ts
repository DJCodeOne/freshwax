// src/pages/api/relay-status.ts
// Proxy for checking relay station status (avoids CORS issues)

import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, fetchWithTimeout, jsonResponse, successResponse } from '../../lib/api-utils';

const STATION_CHECK_URLS: Record<string, string | null> = {
  'underground-lair': 'https://cressida.shoutca.st:2199/rpc/theundergroundlair/streaminfo.get',
  'somafm-groovesalad': null // SomaFM is always live, no check needed
};

export const GET: APIRoute = async ({ request, url }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`relay-status:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const stationId = url.searchParams.get('station');

  if (!stationId || !(stationId in STATION_CHECK_URLS)) {
    return ApiErrors.badRequest('Unknown station');
  }

  const checkUrl = STATION_CHECK_URLS[stationId];

  // Stations without check URL are assumed always live
  if (!checkUrl) {
    return successResponse({ isLive: true,
      nowPlaying: '',
      listeners: 0 });
  }

  try {
    const response = await fetchWithTimeout(checkUrl, {}, 5000);

    if (!response.ok) {
      return jsonResponse({
        success: false,
        isLive: false,
        error: 'Station unreachable'
      });
    }

    const text = await response.text();

    // Parse Shoutcast JSON response
    if (checkUrl.includes('shoutca.st') || checkUrl.includes('streaminfo.get')) {
      try {
        const json = JSON.parse(text);
        if (json.type === 'result' && json.data && json.data[0]) {
          const data = json.data[0];
          const isLive = data.server === 'Online' && data.sourcestate === true;
          return successResponse({ isLive,
            nowPlaying: isLive ? data.song : '',
            listeners: data.listeners || 0 });
        }
      } catch (e: unknown) {
        // Not valid JSON
      }
    }

    // Fallback for other formats
    const nowPlaying = text.trim();
    const isLive = nowPlaying && nowPlaying !== 'Unknown - Track';

    return successResponse({ isLive,
      nowPlaying: isLive ? nowPlaying : '' });

  } catch (err: unknown) {
    return jsonResponse({
      success: false,
      isLive: false,
      error: 'Check failed'
    });
  }
};
