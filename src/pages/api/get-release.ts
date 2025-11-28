// src/pages/api/get-release.ts
// Uses Firebase REST API - works on Cloudflare Pages (no Admin SDK)
import type { APIRoute } from 'astro';
import { getDocument } from '../../lib/firebase-rest';

export const prerender = false;

// Helper function to get label from release data
function getLabelFromRelease(release: any): string {
  return release.labelName || 
         release.label || 
         release.recordLabel || 
         release.copyrightHolder || 
         'Unknown Label';
}

// Helper function to normalize ratings data
function normalizeRatings(data: any): { average: number; count: number; total: number; fiveStarCount: number } {
  const ratings = data.ratings || data.overallRating || {};
  
  return {
    average: Number(ratings.average) || 0,
    count: Number(ratings.count) || 0,
    total: Number(ratings.total) || 0,
    fiveStarCount: Number(ratings.fiveStarCount) || 0
  };
}

// Normalize a release document
function normalizeRelease(data: any, id: string): any {
  if (!data) return null;
  
  return {
    id,
    ...data,
    label: getLabelFromRelease(data),
    ratings: normalizeRatings(data),
    tracks: (data.tracks || []).map((track: any, index: number) => ({
      ...track,
      trackNumber: track.trackNumber || track.displayTrackNumber || (index + 1),
      displayTrackNumber: track.displayTrackNumber || track.trackNumber || (index + 1),
      previewUrl: track.previewUrl || track.preview_url || track.mp3Url || null,
      duration: track.duration || null,
      ratings: track.ratings ? {
        average: Number(track.ratings.average) || 0,
        count: Number(track.ratings.count) || 0,
        total: Number(track.ratings.total) || 0
      } : undefined
    }))
  };
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const releaseId = url.searchParams.get('id');
  
  if (!releaseId) {
    return new Response(JSON.stringify({ 
      success: false,
      error: 'Release ID required' 
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  console.log(`[GET-RELEASE] Fetching release: ${releaseId}`);
  
  try {
    // Fetch single document using REST API
    const release = await getDocument('releases', releaseId);
    
    if (!release) {
      console.log(`[GET-RELEASE] ✗ Not found: ${releaseId}`);
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Release not found' 
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Check status
    if (release.status !== 'live') {
      console.log(`[GET-RELEASE] ✗ Status not live: ${releaseId} (status: ${release.status})`);
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Release not available' 
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Normalize the release data
    const normalized = normalizeRelease(release, releaseId);
    
    console.log(`[GET-RELEASE] ✓ Returning:`, {
      id: normalized.id,
      artistName: normalized.artistName,
      releaseName: normalized.releaseName,
      trackCount: normalized.tracks?.length || 0
    });
    
    return new Response(JSON.stringify({ 
      success: true,
      release: normalized,
      source: 'firebase-rest'
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, s-maxage=300'
      }
    });
    
  } catch (error) {
    console.error('[GET-RELEASE] Error:', error);
    return new Response(JSON.stringify({ 
      success: false,
      error: 'Failed to fetch release',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};