// src/pages/api/get-releases.ts
// Uses Firebase REST API - works on Cloudflare Pages
// Uses KV caching to reduce Firebase reads
import type { APIRoute } from 'astro';
import { queryCollection } from '../../lib/firebase-rest';
import { initKVCache, kvGet, kvSet, CACHE_CONFIG } from '../../lib/kv-cache';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
  initKVCache(env);

  const url = new URL(request.url);
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? parseInt(limitParam) : 100;
  const skipCache = url.searchParams.get('fresh') === '1';

  log.info('[get-releases] Fetching up to', limit, 'releases');

  // Try KV cache first (5 min TTL)
  const cacheKey = `releases:${limit}`;
  if (!skipCache) {
    const cached = await kvGet(cacheKey, CACHE_CONFIG.RELEASES);
    if (cached) {
      log.info('[get-releases] KV cache hit');
      return new Response(JSON.stringify(cached), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300, s-maxage=300'
        }
      });
    }
  }

  try {
    const allReleases = await queryCollection('releases', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'live' }]
    });
    
    const normalizedReleases = allReleases.map(release => ({
      id: release.id,
      ...release,
      ratingsAverage: release.ratings?.average || 0,
      ratingsCount: release.ratings?.count || 0,
      fiveStarCount: release.ratings?.fiveStarCount || 0,
      comments: release.comments || [],
      metadata: {
        notes: release.metadata?.notes || '',
        officialReleaseDate: release.metadata?.officialReleaseDate || null
      }
    }));
    
    normalizedReleases.sort((a, b) => {
      const dateA = new Date(a.releaseDate || 0).getTime();
      const dateB = new Date(b.releaseDate || 0).getTime();
      return dateB - dateA;
    });
    
    const limitedReleases = limit > 0 ? normalizedReleases.slice(0, limit) : normalizedReleases;

    log.info('[get-releases] Returning', limitedReleases.length, 'of', allReleases.length);

    const result = {
      success: true,
      releases: limitedReleases,
      totalReleases: limitedReleases.length,
      source: 'firebase-rest',
      limited: limit > 0
    };

    // Cache in KV for 10 minutes
    kvSet(cacheKey, result, CACHE_CONFIG.RELEASES);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, s-maxage=300'
      }
    });
    
  } catch (error) {
    log.error('[get-releases] Error:', error);
    return new Response(JSON.stringify({ 
      success: false,
      error: 'Failed to fetch releases',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};