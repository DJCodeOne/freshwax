// src/pages/api/relay-status.ts
// Proxy for checking relay station status (avoids CORS issues)

import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, fetchWithTimeout } from '../../lib/api-utils';

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
    return new Response(JSON.stringify({
      success: true,
      isLive: true,
      nowPlaying: '',
      listeners: 0
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const response = await fetchWithTimeout(checkUrl, {}, 5000);

    if (!response.ok) {
      return new Response(JSON.stringify({
        success: false,
        isLive: false,
        error: 'Station unreachable'
      }), {
        headers: { 'Content-Type': 'application/json' }
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
          return new Response(JSON.stringify({
            success: true,
            isLive,
            nowPlaying: isLive ? data.song : '',
            listeners: data.listeners || 0
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      } catch {
        // Not valid JSON
      }
    }

    // Fallback for other formats
    const nowPlaying = text.trim();
    const isLive = nowPlaying && nowPlaying !== 'Unknown - Track';

    return new Response(JSON.stringify({
      success: true,
      isLive,
      nowPlaying: isLive ? nowPlaying : ''
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err: unknown) {
    return new Response(JSON.stringify({
      success: false,
      isLive: false,
      error: 'Check failed'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
