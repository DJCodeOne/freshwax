// src/pages/api/search-releases.ts
// OPTIMIZED: Uses long-lived cache for search data
import type { APIRoute } from 'astro';
import { queryCollection } from '../../lib/firebase-rest';

export const prerender = false;

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

// Server-side cache for search data - reduces Firebase reads dramatically
let cachedReleases: any[] | null = null;
let cachedMixes: any[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes - search data doesn't need to be real-time

async function getCachedReleases(): Promise<any[]> {
  const now = Date.now();
  if (cachedReleases && (now - cacheTimestamp) < CACHE_TTL) {
    log.info('[search-releases] Using cached releases:', cachedReleases.length);
    return cachedReleases;
  }
  
  log.info('[search-releases] Fetching fresh releases...');
  let releases = await queryCollection('releases', { 
    filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
    cacheKey: 'search-all-releases',
    cacheTTL: CACHE_TTL
  });
  
  if (releases.length === 0) {
    releases = await queryCollection('releases', { 
      filters: [{ field: 'published', op: 'EQUAL', value: true }],
      cacheKey: 'search-all-releases-published',
      cacheTTL: CACHE_TTL
    });
  }
  
  cachedReleases = releases;
  cacheTimestamp = now;
  return releases;
}

async function getCachedMixes(): Promise<any[]> {
  const now = Date.now();
  if (cachedMixes && (now - cacheTimestamp) < CACHE_TTL) {
    log.info('[search-releases] Using cached mixes:', cachedMixes.length);
    return cachedMixes;
  }
  
  log.info('[search-releases] Fetching fresh mixes...');
  let mixes = await queryCollection('dj-mixes', { 
    filters: [{ field: 'published', op: 'EQUAL', value: true }],
    cacheKey: 'search-all-mixes',
    cacheTTL: CACHE_TTL
  });
  
  if (mixes.length === 0) {
    mixes = await queryCollection('dj-mixes', { 
      filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
      cacheKey: 'search-all-mixes-live',
      cacheTTL: CACHE_TTL
    });
  }
  
  cachedMixes = mixes;
  return mixes;
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const query = url.searchParams.get('q')?.toLowerCase().trim();
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? parseInt(limitParam) : 20;
  
  if (!query || query.length < 2) {
    return new Response(JSON.stringify({ success: false, error: 'Search query must be at least 2 characters' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  
  log.info('[search-releases] Searching for:', query);
  
  try {
    // Use cached data - dramatically reduces Firebase reads
    const [allReleases, allMixes] = await Promise.all([
      getCachedReleases(),
      getCachedMixes()
    ]);
    
    log.info('[search-releases] Searching', allReleases.length, 'releases and', allMixes.length, 'mixes');
    
    const releaseSearchFields = ['releaseName', 'artistName', 'label', 'labelName', 'recordLabel', 'catalogNumber', 'title', 'artist'];
    
    const matchedReleases = allReleases.filter((release: any) => {
      for (const field of releaseSearchFields) {
        const value = release[field];
        if (value && typeof value === 'string' && value.toLowerCase().includes(query)) return true;
      }
      for (const track of (release.tracks || [])) {
        const trackName = track.trackName || track.title || track.name;
        if (trackName && trackName.toLowerCase().includes(query)) return true;
      }
      const genres = release.genres || release.genre || [];
      if (Array.isArray(genres)) {
        for (const genre of genres) {
          if (typeof genre === 'string' && genre.toLowerCase().includes(query)) return true;
        }
      }
      return false;
    }).map((release: any) => ({
      id: release.id,
      type: 'release',
      title: release.releaseName || release.title || 'Untitled',
      artist_name: release.artistName || release.artist || 'Unknown Artist',
      artwork_url: release.artwork?.cover || release.coverArtUrl || release.artworkUrl || '/logo.webp'
    }));
    
    const mixSearchFields = ['title', 'name', 'artist', 'djName', 'dj_name', 'genre', 'description'];
    
    const matchedMixes = allMixes.filter((mix: any) => {
      for (const field of mixSearchFields) {
        const value = mix[field];
        if (value && typeof value === 'string' && value.toLowerCase().includes(query)) return true;
      }
      const genres = mix.genres || mix.genre || [];
      if (Array.isArray(genres)) {
        for (const genre of genres) {
          if (typeof genre === 'string' && genre.toLowerCase().includes(query)) return true;
        }
      }
      return false;
    }).map((mix: any) => ({
      id: mix.id,
      type: 'mix',
      title: mix.title || mix.name || 'Untitled Mix',
      artist_name: mix.djName || mix.dj_name || mix.artist || 'Unknown DJ',
      artwork_url: mix.artwork || mix.artworkUrl || mix.artwork_url || mix.coverImage || '/logo.webp'
    }));
    
    const allResults = [...matchedReleases, ...matchedMixes];
    const limitedResults = allResults.slice(0, limit);
    
    log.info('[search-releases] Found', matchedReleases.length, 'releases,', matchedMixes.length, 'mixes, returning', limitedResults.length);
    
    return new Response(JSON.stringify({ 
      success: true, 
      results: limitedResults,
      total: allResults.length, 
      returned: limitedResults.length,
      releaseCount: matchedReleases.length,
      mixCount: matchedMixes.length,
      source: 'firebase-rest-cached' 
    }), {
      status: 200, 
      headers: { 
        'Content-Type': 'application/json', 
        'Cache-Control': 'public, max-age=120, s-maxage=300' // Browser: 2 min, CDN: 5 min
      }
    });
    
  } catch (error) {
    log.error('[search-releases] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Search failed', details: error instanceof Error ? error.message : 'Unknown error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
