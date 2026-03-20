// src/pages/api/giphy/search.ts
// Server-side GIPHY proxy to keep API key secure
import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { fetchWithTimeout, ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('giphy/search');

export const prerender = false;

// Cache GIPHY responses for 5 minutes to reduce API calls
const giphyCache = new Map<string, { data: Record<string, unknown>; expires: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached(key: string): Record<string, unknown> | null {
  const entry = giphyCache.get(key);
  if (entry && Date.now() < entry.expires) {
    return entry.data;
  }
  if (entry) giphyCache.delete(key);
  return null;
}

function setCache(key: string, data: Record<string, unknown>): void {
  giphyCache.set(key, { data, expires: Date.now() + CACHE_TTL });
  // Prune cache if too large
  if (giphyCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of giphyCache.entries()) {
      if (v.expires < now) giphyCache.delete(k);
    }
  }
}

export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit: 30 GIPHY requests per minute per client
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`giphy:${clientId}`, RateLimiters.chat);
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  const url = new URL(request.url);
  const query = url.searchParams.get('q') || '';
  const endpoint = url.searchParams.get('endpoint') || 'search'; // search or trending
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
  const offset = parseInt(url.searchParams.get('offset') || '0');

  if (endpoint === 'search' && !query) {
    return ApiErrors.badRequest('Query parameter required for search');
  }

  // Get API key from environment (free public beta key)
  const env = locals.runtime.env;
  const apiKey = env?.PUBLIC_GIPHY_API_KEY || import.meta.env.PUBLIC_GIPHY_API_KEY;

  if (!apiKey) {
    return ApiErrors.serverError('GIPHY API not configured');
  }

  // Check cache
  const cacheKey = `${endpoint}:${query}:${limit}:${offset}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return successResponse({ ...cached,
      cached: true }, 200, { headers: { 'Cache-Control': 'public, max-age=300' } });
  }

  try {
    const giphyUrl = endpoint === 'trending'
      ? `https://api.giphy.com/v1/gifs/trending?api_key=${apiKey}&limit=${limit}&offset=${offset}&rating=pg-13`
      : `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}&rating=pg-13`;

    const response = await fetchWithTimeout(giphyUrl, {}, 10000);

    if (!response.ok) {
      throw new Error(`GIPHY API error: ${response.status}`);
    }

    const data = await response.json();

    // Transform response to only include necessary data
    const gifsArray = Array.isArray(data?.data) ? data.data : [];
    const gifs = gifsArray.map((gif: Record<string, unknown>) => {
      const images = gif.images as Record<string, Record<string, unknown>> | undefined;
      const fixedHeight = images?.fixed_height;
      const fixedHeightSmall = images?.fixed_height_small;
      return {
        id: gif.id,
        title: gif.title,
        url: fixedHeight?.url || '',
        width: fixedHeight?.width || '',
        height: fixedHeight?.height || '',
        preview: fixedHeightSmall?.url || '',
        webp: fixedHeight?.webp || '',
      };
    });

    const result = {
      gifs,
      pagination: data.pagination,
    };

    // Cache the result
    setCache(cacheKey, result);

    return successResponse({ ...result }, 200, { headers: { 'Cache-Control': 'public, max-age=300' } });

  } catch (error: unknown) {
    log.error('[GIPHY Proxy] Error:', error);
    return ApiErrors.serverError('Failed to fetch from GIPHY');
  }
};
