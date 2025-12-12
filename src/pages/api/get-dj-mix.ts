// src/pages/api/get-dj-mix.ts
// Uses Firebase REST API - works on Cloudflare Pages
import type { APIRoute } from 'astro';
import { getDocument, clearCache } from '../../lib/firebase-rest';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const mixId = url.searchParams.get('id');
  const noCache = url.searchParams.get('nocache'); // Bypass cache if present
  
  if (!mixId) {
    return new Response(JSON.stringify({ 
      success: false,
      error: 'Mix ID required' 
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  log.info('[get-dj-mix] Fetching mix:', mixId, noCache ? '(nocache)' : '');
  
  // Clear cache for this mix if nocache requested
  if (noCache) {
    clearCache(`doc:dj-mixes:${mixId}`);
  }
  
  try {
    const mix = await getDocument('dj-mixes', mixId);
    
    if (!mix) {
      log.info('[get-dj-mix] Not found:', mixId);
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Mix not found' 
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const normalized = {
      id: mix.id,
      title: mix.title || mix.name || 'Untitled Mix',
      artist: mix.displayName || mix.artist || mix.djName || mix.dj_name || 'Unknown DJ',
      artwork: mix.artworkUrl || mix.coverUrl || mix.imageUrl || '/place-holder.webp',
      audioUrl: mix.audioUrl || mix.mp3Url || mix.streamUrl || null,
      duration: mix.duration || null,
      genre: mix.genre || mix.genres || [],
      description: mix.description || '',
      tracklist: mix.tracklist || [],
      playCount: mix.playCount || mix.plays || 0,
      likeCount: mix.likeCount || mix.likes || 0,
      downloadCount: mix.downloadCount || mix.downloads || 0,
      uploadedAt: mix.uploadedAt || mix.createdAt || null,
      allowDownload: mix.allowDownload !== false,
      // Include displayName and dj_name explicitly for the frontend
      displayName: mix.displayName || mix.dj_name || mix.djName || 'Unknown DJ',
      dj_name: mix.displayName || mix.dj_name || mix.djName || 'Unknown DJ',
      ...mix
    };
    
    log.info('[get-dj-mix] Returning:', normalized.title);
    
    return new Response(JSON.stringify({ 
      success: true,
      mix: normalized,
      source: 'firebase-rest'
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=60, must-revalidate'
      }
    });
    
  } catch (error) {
    log.error('[get-dj-mix] Error:', error);
    return new Response(JSON.stringify({ 
      success: false,
      error: 'Failed to fetch mix',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
