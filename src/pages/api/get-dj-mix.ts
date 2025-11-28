// src/pages/api/get-dj-mix.ts
// Uses Firebase REST API - works on Cloudflare Pages (no Admin SDK)
import type { APIRoute } from 'astro';
import { getDocument } from '../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const mixId = url.searchParams.get('id');
  
  if (!mixId) {
    return new Response(JSON.stringify({ 
      success: false,
      error: 'Mix ID required' 
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  console.log(`[GET-DJ-MIX] Fetching mix: ${mixId}`);
  
  try {
    // Fetch single document using REST API
    const mix = await getDocument('dj-mixes', mixId);
    
    if (!mix) {
      console.log(`[GET-DJ-MIX] ✗ Not found: ${mixId}`);
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Mix not found' 
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Normalize the mix data
    const normalized = {
      id: mix.id,
      title: mix.title || mix.name || 'Untitled Mix',
      artist: mix.artist || mix.djName || 'Unknown DJ',
      artwork: mix.artworkUrl || mix.coverUrl || mix.imageUrl || '/logo.webp',
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
      ...mix
    };
    
    console.log(`[GET-DJ-MIX] ✓ Returning:`, {
      id: normalized.id,
      title: normalized.title,
      artist: normalized.artist
    });
    
    return new Response(JSON.stringify({ 
      success: true,
      mix: normalized,
      source: 'firebase-rest'
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, s-maxage=300'
      }
    });
    
  } catch (error) {
    console.error('[GET-DJ-MIX] Error:', error);
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