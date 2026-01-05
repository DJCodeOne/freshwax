// src/pages/api/giphy/search.ts
// Server-side GIPHY proxy to keep API key secure
import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

// Cache GIPHY responses for 5 minutes to reduce API calls
const giphyCache = new Map<string, { data: any; expires: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached(key: string): any | null {
  const entry = giphyCache.get(key);
  if (entry && Date.now() < entry.expires) {
    return entry.data;
  }
  if (entry) giphyCache.delete(key);
  return null;
}

function setCache(key: string, data: any): void {
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
    return new Response(JSON.stringify({
      success: false,
      error: 'Query parameter required for search'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Get API key from server environment (never exposed to client)
  const env = (locals as any)?.runtime?.env;
  const apiKey = env?.GIPHY_API_KEY || import.meta.env.GIPHY_API_KEY;

  if (!apiKey) {
    return new Response(JSON.stringify({
      success: false,
      error: 'GIPHY API not configured'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Check cache
  const cacheKey = `${endpoint}:${query}:${limit}:${offset}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return new Response(JSON.stringify({
      success: true,
      ...cached,
      cached: true
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300'
      }
    });
  }

  try {
    const giphyUrl = endpoint === 'trending'
      ? `https://api.giphy.com/v1/gifs/trending?api_key=${apiKey}&limit=${limit}&offset=${offset}&rating=pg-13`
      : `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}&rating=pg-13`;

    const response = await fetch(giphyUrl);

    if (!response.ok) {
      throw new Error(`GIPHY API error: ${response.status}`);
    }

    const data = await response.json();

    // Transform response to only include necessary data
    const gifs = data.data.map((gif: any) => ({
      id: gif.id,
      title: gif.title,
      url: gif.images.fixed_height.url,
      width: gif.images.fixed_height.width,
      height: gif.images.fixed_height.height,
      preview: gif.images.fixed_height_small.url,
      webp: gif.images.fixed_height.webp,
    }));

    const result = {
      gifs,
      pagination: data.pagination,
    };

    // Cache the result
    setCache(cacheKey, result);

    return new Response(JSON.stringify({
      success: true,
      ...result
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300'
      }
    });

  } catch (error) {
    console.error('[GIPHY Proxy] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch from GIPHY'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
