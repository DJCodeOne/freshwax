// src/pages/api/search-releases.ts
// OPTIMIZED: Uses D1 for search data - zero Firebase reads
import type { APIRoute } from 'astro';
import { d1SearchPublishedReleases, d1SearchPublishedMixes, d1SearchPublishedMerch } from '../../lib/d1-catalog';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

export const prerender = false;

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`search-releases:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const url = new URL(request.url);
  const query = url.searchParams.get('q')?.toLowerCase().trim();
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? parseInt(limitParam) : 20;

  if (!query || query.length < 2) {
    return new Response(JSON.stringify({ success: false, error: 'Search query must be at least 2 characters' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  // Get D1 database from Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  const db = env?.DB;

  if (!db) {
    return new Response(JSON.stringify({ success: false, error: 'Database not available' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  log.info('[search] Searching for:', query);

  try {
    // Use D1 SQL LIKE for server-side search - much faster than fetching all records
    const [releases, mixes, merch] = await Promise.all([
      d1SearchPublishedReleases(db, query, limit),
      d1SearchPublishedMixes(db, query, limit),
      d1SearchPublishedMerch(db, query, limit)
    ]);

    log.info('[search] D1 search found', releases.length, 'releases,', mixes.length, 'mixes,', merch.length, 'merch');

    const matchedReleases = releases.map((release: any) => ({
      id: release.id,
      type: 'release',
      title: release.releaseName || release.title || 'Untitled',
      artist_name: release.artistName || release.artist || 'Unknown Artist',
      artwork_url: release.thumbUrl || release.artwork?.cover || release.coverArtUrl || release.artworkUrl || '/place-holder.webp'
    }));

    const matchedMixes = mixes.map((mix: any) => ({
      id: mix.id,
      type: 'mix',
      title: mix.title || mix.name || 'Untitled Mix',
      artist_name: mix.djName || mix.dj_name || mix.artist || 'Unknown DJ',
      artwork_url: mix.artwork || mix.artworkUrl || mix.artwork_url || mix.coverImage || '/place-holder.webp'
    }));

    const matchedMerch = merch.map((item: any) => ({
      id: item.id,
      type: 'merch',
      title: item.name || 'Untitled Product',
      artist_name: item.supplierName || item.categoryName || 'Fresh Wax',
      artwork_url: item.primaryImage || (item.images?.[0]?.url) || item.imageUrl || '/place-holder.webp',
      price: item.retailPrice || item.price || 0,
      stock: item.totalStock || item.stock || 0
    }));

    // Combine results: releases first, then mixes, then merch
    const allResults = [...matchedReleases, ...matchedMixes, ...matchedMerch];
    const limitedResults = allResults.slice(0, limit);

    log.info('[search] Found', matchedReleases.length, 'releases,', matchedMixes.length, 'mixes,', matchedMerch.length, 'merch, returning', limitedResults.length);

    return new Response(JSON.stringify({
      success: true,
      results: limitedResults,
      total: allResults.length,
      returned: limitedResults.length,
      releaseCount: matchedReleases.length,
      mixCount: matchedMixes.length,
      merchCount: matchedMerch.length,
      source: 'd1'
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60, s-maxage=180' // Browser: 1 min, CDN: 3 min
      }
    });

  } catch (error) {
    log.error('[search] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Search failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
