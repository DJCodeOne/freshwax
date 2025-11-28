// src/pages/api/get-releases.ts
// Uses Firebase REST API - works on Cloudflare Pages (no Admin SDK)
import type { APIRoute } from 'astro';
import { queryCollection } from '../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? parseInt(limitParam) : 100;
  
  console.log(`[GET-RELEASES] Fetching up to ${limit} releases via REST API...`);
  
  try {
    // Query releases with status='live' using REST API
    const allReleases = await queryCollection('releases', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'live' }]
    });
    
    // Normalize and enrich the data
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
    
    // Sort by releaseDate in-memory (newest first)
    normalizedReleases.sort((a, b) => {
      const dateA = new Date(a.releaseDate || 0).getTime();
      const dateB = new Date(b.releaseDate || 0).getTime();
      return dateB - dateA;
    });
    
    // Apply limit after sorting
    const limitedReleases = limit > 0 ? normalizedReleases.slice(0, limit) : normalizedReleases;
    
    console.log(`[GET-RELEASES] ✓ Loaded ${allReleases.length} releases, returning ${limitedReleases.length} (limit: ${limit})`);
    
    return new Response(JSON.stringify({ 
      success: true,
      releases: limitedReleases,
      totalReleases: limitedReleases.length,
      source: 'firebase-rest',
      limited: limit > 0
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, s-maxage=300'
      }
    });
    
  } catch (error) {
    console.error('[GET-RELEASES] Error:', error);
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