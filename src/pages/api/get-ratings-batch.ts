// src/pages/api/get-ratings-batch.ts
// Uses Firebase REST API - works on Cloudflare Pages (no Admin SDK)
// Fetches ratings for multiple releases in one call
import type { APIRoute } from 'astro';
import { getDocument } from '../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const idsParam = url.searchParams.get('ids');

    if (!idsParam) {
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Release IDs required (comma-separated)' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const releaseIds = idsParam.split(',').map(id => id.trim()).filter(Boolean);
    
    if (releaseIds.length === 0) {
      return new Response(JSON.stringify({ 
        success: false,
        error: 'No valid release IDs provided' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Limit batch size to prevent abuse
    const maxBatchSize = 50;
    const limitedIds = releaseIds.slice(0, maxBatchSize);
    
    console.log(`[get-ratings-batch] Fetching ratings for ${limitedIds.length} releases`);

    // Fetch all releases in parallel using REST API
    const results = await Promise.all(
      limitedIds.map(async (releaseId) => {
        try {
          const release = await getDocument('releases', releaseId);
          if (!release) {
            return { id: releaseId, found: false };
          }
          
          const ratings = release.ratings || {};
          return {
            id: releaseId,
            found: true,
            average: ratings.average || 0,
            count: ratings.count || 0,
            fiveStarCount: ratings.fiveStarCount || 0,
            total: ratings.total || 0
          };
        } catch (err) {
          console.error(`[get-ratings-batch] Error fetching ${releaseId}:`, err);
          return { id: releaseId, found: false, error: true };
        }
      })
    );

    // Convert to object keyed by release ID for easy lookup
    const ratingsMap: Record<string, any> = {};
    results.forEach(result => {
      if (result.found) {
        ratingsMap[result.id] = {
          average: result.average,
          count: result.count,
          fiveStarCount: result.fiveStarCount,
          total: result.total
        };
      }
    });

    console.log(`[get-ratings-batch] ✓ Returned ratings for ${Object.keys(ratingsMap).length}/${limitedIds.length} releases`);

    return new Response(JSON.stringify({
      success: true,
      ratings: ratingsMap,
      requested: limitedIds.length,
      found: Object.keys(ratingsMap).length,
      source: 'firebase-rest'
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60, s-maxage=60'
      }
    });

  } catch (error) {
    console.error('[get-ratings-batch] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch ratings batch'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};