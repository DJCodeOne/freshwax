// src/pages/api/get-release.ts
// Uses Firebase REST API - works on Cloudflare Pages
import type { APIRoute } from 'astro';
import { getDocument, clearCache } from '../../lib/firebase-rest';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

function getLabelFromRelease(release: any): string {
  return release.labelName || 
         release.label || 
         release.recordLabel || 
         release.copyrightHolder || 
         'Unknown Label';
}

function normalizeRatings(data: any): { average: number; count: number; total: number; fiveStarCount: number } {
  const ratings = data.ratings || data.overallRating || {};
  
  return {
    average: Number(ratings.average) || 0,
    count: Number(ratings.count) || 0,
    total: Number(ratings.total) || 0,
    fiveStarCount: Number(ratings.fiveStarCount) || 0
  };
}

function normalizeRelease(data: any, id: string): any {
  if (!data) return null;
  
  const normalizedRatings = normalizeRatings(data);
  
  return {
    id,
    ...data,
    label: getLabelFromRelease(data),
    ratings: normalizedRatings,
    overallRating: normalizedRatings, // Also return as overallRating for backward compatibility
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
  const noCache = url.searchParams.get('nocache'); // Bypass cache if present
  const isAdmin = url.searchParams.get('admin') === 'true'; // Allow viewing non-live releases
  
  if (!releaseId) {
    return new Response(JSON.stringify({ 
      success: false,
      error: 'Release ID required' 
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  log.info('[get-release] Fetching:', releaseId, noCache ? '(nocache)' : '', isAdmin ? '(admin)' : '');
  
  // Clear cache for this release if nocache requested
  if (noCache) {
    clearCache(`doc:releases:${releaseId}`);
  }
  
  try {
    const release = await getDocument('releases', releaseId);
    
    if (!release) {
      log.info('[get-release] Not found:', releaseId);
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Release not found' 
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Only check status for public requests (non-admin)
    if (!isAdmin && release.status !== 'live') {
      log.info('[get-release] Not live:', releaseId, release.status);
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Release not available' 
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const normalized = normalizeRelease(release, releaseId);
    
    log.info('[get-release] Returning:', normalized.artistName, '-', normalized.releaseName);
    
    return new Response(JSON.stringify({ 
      success: true,
      release: normalized,
      source: 'firebase-rest'
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=60, must-revalidate'
      }
    });
    
  } catch (error) {
    log.error('[get-release] Error:', error);
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