// src/pages/api/get-shuffle-tracks.ts
// Uses Firebase REST API - works on Cloudflare Pages
import type { APIRoute } from 'astro';
import { 
  getLiveReleases, 
  extractTracksFromReleases, 
  shuffleArray 
} from '../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const startTime = Date.now();
  
  try {
    console.log('[get-shuffle-tracks] Fetching via REST API...');
    
    // Fetch releases using REST API (no Admin SDK)
    const releases = await getLiveReleases(30);
    console.log(`[get-shuffle-tracks] Found ${releases.length} releases`);
    
    // Extract tracks with audio URLs
    const allTracks = extractTracksFromReleases(releases);
    console.log(`[get-shuffle-tracks] Extracted ${allTracks.length} tracks with audio`);
    
    // Shuffle and limit
    const shuffled = shuffleArray(allTracks);
    const result = shuffled.slice(0, 30);
    
    const duration = Date.now() - startTime;
    console.log(`[get-shuffle-tracks] ✓ Returning ${result.length} tracks (${duration}ms)`);
    
    return new Response(JSON.stringify({
      success: true,
      tracks: result,
      meta: {
        total: allTracks.length,
        returned: result.length,
        fetchTime: duration
      }
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, s-maxage=300' // 5 min cache
      }
    });
    
  } catch (error: any) {
    console.error('[get-shuffle-tracks] Error:', error);
    
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to fetch tracks',
      tracks: []
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};