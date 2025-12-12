// src/pages/api/get-dj-mixes.ts
// Uses Firebase REST API - works on Cloudflare Pages (no Admin SDK)
import type { APIRoute } from 'astro';
import { queryCollection } from '../../lib/firebase-rest';

export const prerender = false;

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const limitParam = url.searchParams.get('limit');
  const userId = url.searchParams.get('userId');
  const limit = limitParam ? parseInt(limitParam) : 50;
  
  log.info('[get-dj-mixes] Fetching mixes, userId:', userId, 'limit:', limit);
  
  try {
    let mixes: any[] = [];
    
    // If userId provided, filter by userId
    if (userId) {
      mixes = await queryCollection('dj-mixes', {
        filters: [{ field: 'userId', op: 'EQUAL', value: userId }]
      });
      log.info('[get-dj-mixes] Found', mixes.length, 'mixes for user');
    } else {
      // Query mixes - try 'published' field first, then 'status'
      mixes = await queryCollection('dj-mixes', {
        filters: [{ field: 'published', op: 'EQUAL', value: true }]
      });
      
      // If no results with 'published', try 'status'
      if (mixes.length === 0) {
        mixes = await queryCollection('dj-mixes', {
          filters: [{ field: 'status', op: 'EQUAL', value: 'live' }]
        });
      }
      
      // If still no results, try without filter (get all)
      if (mixes.length === 0) {
        const { documents } = await import('../../lib/firebase-rest').then(m => m.listCollection('dj-mixes', limit));
        mixes = documents;
      }
    }
    
    // Normalize mix data
    const normalizedMixes = mixes.map(mix => ({
      id: mix.id,
      title: mix.title || mix.name || 'Untitled Mix',
      artist: mix.artist || mix.djName || 'Unknown DJ',
      artwork: mix.artworkUrl || mix.coverUrl || mix.imageUrl || '/place-holder.webp',
      audioUrl: mix.audioUrl || mix.mp3Url || mix.streamUrl || null,
      duration: mix.duration || null,
      genre: mix.genre || mix.genres || [],
      description: mix.description || '',
      playCount: mix.playCount || mix.plays || 0,
      likeCount: mix.likeCount || mix.likes || 0,
      downloadCount: mix.downloadCount || mix.downloads || 0,
      uploadedAt: mix.uploadedAt || mix.createdAt || null,
      ...mix
    }));
    
    // Sort by upload date (newest first)
    normalizedMixes.sort((a, b) => {
      const dateA = new Date(a.uploadedAt || 0).getTime();
      const dateB = new Date(b.uploadedAt || 0).getTime();
      return dateB - dateA;
    });
    
    // Apply limit
    const limitedMixes = limit > 0 ? normalizedMixes.slice(0, limit) : normalizedMixes;
    
    log.info('[get-dj-mixes] Loaded', mixes.length, 'mixes, returning', limitedMixes.length);
    
    return new Response(JSON.stringify({ 
      success: true,
      mixes: limitedMixes,
      total: limitedMixes.length,
      source: 'firebase-rest'
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, s-maxage=300'
      }
    });
    
  } catch (error) {
    log.error('[get-dj-mixes] Error:', error);
    return new Response(JSON.stringify({ 
      success: false,
      error: 'Failed to fetch DJ mixes',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};