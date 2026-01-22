// src/pages/api/search-releases.ts
// OPTIMIZED: Uses D1 for search data - zero Firebase reads
import type { APIRoute } from 'astro';
import { d1GetAllPublishedReleases, d1GetAllPublishedMixes, d1GetAllPublishedMerch } from '../../lib/d1-catalog';

export const prerender = false;

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const GET: APIRoute = async ({ request, locals }) => {
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
    // Use D1 for all search data - zero Firebase reads
    const [allReleases, allMixes, allMerch] = await Promise.all([
      d1GetAllPublishedReleases(db),
      d1GetAllPublishedMixes(db),
      d1GetAllPublishedMerch(db)
    ]);

    log.info('[search] Searching', allReleases.length, 'releases,', allMixes.length, 'mixes,', allMerch.length, 'merch');

    // Search releases
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
      artwork_url: release.artwork?.cover || release.coverArtUrl || release.artworkUrl || '/place-holder.webp'
    }));

    // Search mixes
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
      artwork_url: mix.artwork || mix.artworkUrl || mix.artwork_url || mix.coverImage || '/place-holder.webp'
    }));

    // Search merch
    const merchSearchFields = ['name', 'description', 'category', 'categoryName', 'supplierName', 'sku'];

    const matchedMerch = allMerch.filter((item: any) => {
      for (const field of merchSearchFields) {
        const value = item[field];
        if (value && typeof value === 'string' && value.toLowerCase().includes(query)) return true;
      }
      // Search colors and sizes
      const colors = item.colors || [];
      const sizes = item.sizes || [];
      if (colors.some((c: string) => c.toLowerCase().includes(query))) return true;
      if (sizes.some((s: string) => s.toLowerCase().includes(query))) return true;
      return false;
    }).map((item: any) => ({
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
    return new Response(JSON.stringify({ success: false, error: 'Search failed', details: error instanceof Error ? error.message : 'Unknown error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
