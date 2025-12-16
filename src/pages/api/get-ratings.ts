// src/pages/api/get-ratings.ts
// Uses Firebase REST API - works on Cloudflare Pages
import type { APIRoute } from 'astro';
import { getDocument, initFirebaseEnv } from '../../lib/firebase-rest';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

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

    log.info('[get-ratings] Fetching ratings for:', releaseId);

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

    log.info('[get-ratings] Found:', ratings);

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
        'Cache-Control': 'public, max-age=60, s-maxage=60'
      }
    });

  } catch (error) {
    log.error('[get-ratings] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch ratings'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};