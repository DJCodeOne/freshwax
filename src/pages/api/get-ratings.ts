// src/pages/api/get-ratings.ts
// Uses Firebase REST API - works on Cloudflare Pages (no Admin SDK)
import type { APIRoute } from 'astro';
import { getDocument } from '../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const releaseId = url.searchParams.get('releaseId');

    if (!releaseId) {
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Release ID required' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log(`[get-ratings] Fetching ratings for: ${releaseId}`);

    // Fetch release document using REST API
    const release = await getDocument('releases', releaseId);
    
    if (!release) {
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Release not found' 
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const ratings = release.ratings || { average: 0, count: 0, fiveStarCount: 0 };

    console.log(`[get-ratings] ✓ Release: ${releaseId}`, ratings);

    return new Response(JSON.stringify({
      success: true,
      average: ratings.average || 0,
      count: ratings.count || 0,
      fiveStarCount: ratings.fiveStarCount || 0,
      source: 'firebase-rest'
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60, s-maxage=60' // Shorter cache for ratings
      }
    });

  } catch (error) {
    console.error('[get-ratings] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch ratings'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};