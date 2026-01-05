// src/pages/api/get-shuffle-tracks.ts
import type { APIRoute } from 'astro';
import { getLiveReleases, extractTracksFromReleases, shuffleArray, initFirebaseEnv } from '../../lib/firebase-rest';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

let pendingRequest: Promise<any> | null = null;
let lastFetchTime = 0;
const CACHE_DURATION = 5 * 60 * 1000;
let cachedResult: any = null;

export const GET: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
  const startTime = Date.now();
  
  try {
    if (cachedResult && (Date.now() - lastFetchTime) < CACHE_DURATION) {
      log.info('[get-shuffle-tracks] Returning cached result');
      
      const reshuffled = shuffleArray([...cachedResult.tracks]).slice(0, 30);
      
      return new Response(JSON.stringify({
        success: true,
        tracks: reshuffled,
        meta: {
          ...cachedResult.meta,
          cached: true,
          reshuffled: true
        }
      }), {
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60, s-maxage=300'
        }
      });
    }
    
    if (pendingRequest) {
      log.info('[get-shuffle-tracks] Waiting for pending request');
      const result = await pendingRequest;
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    pendingRequest = (async () => {
      log.info('[get-shuffle-tracks] Fetching fresh data');

      // Get D1 binding for optimized reads
      const db = env?.DB;
      const releases = await getLiveReleases(50, db);
      const allTracks = extractTracksFromReleases(releases);
      
      cachedResult = {
        tracks: allTracks,
        meta: {
          total: allTracks.length,
          fetchTime: Date.now() - startTime
        }
      };
      lastFetchTime = Date.now();
      
      const shuffled = shuffleArray([...allTracks]).slice(0, 30);
      
      return {
        success: true,
        tracks: shuffled,
        meta: {
          total: allTracks.length,
          returned: shuffled.length,
          fetchTime: Date.now() - startTime,
          cached: false
        }
      };
    })();
    
    const result = await pendingRequest;
    pendingRequest = null;
    
    log.info('[get-shuffle-tracks] Returning', result.tracks.length, 'tracks');
    
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60, s-maxage=300'
      }
    });
    
  } catch (error: any) {
    pendingRequest = null;
    log.error('[get-shuffle-tracks] Error:', error);
    
    if (cachedResult) {
      log.info('[get-shuffle-tracks] Returning stale cache');
      const reshuffled = shuffleArray([...cachedResult.tracks]).slice(0, 30);
      return new Response(JSON.stringify({
        success: true,
        tracks: reshuffled,
        meta: { ...cachedResult.meta, stale: true }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
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