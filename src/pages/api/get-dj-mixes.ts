// src/pages/api/get-dj-mixes.ts
// Uses Firebase REST API - works on Cloudflare Pages (no Admin SDK)
import type { APIRoute } from 'astro';
import { queryCollection, initFirebaseEnv } from '../../lib/firebase-rest';

export const prerender = false;

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const GET: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  const url = new URL(request.url);
  const limitParam = url.searchParams.get('limit');
  const userId = url.searchParams.get('userId');
  const limit = limitParam ? parseInt(limitParam) : 50;
  
  log.info('[get-dj-mixes] Fetching mixes, userId:', userId, 'limit:', limit);
  
  try {
    let mixes: any[] = [];
    
    // If userId provided, filter by userId
    if (userId) {
      // Try userId field first
      mixes = await queryCollection('dj-mixes', {
        filters: [{ field: 'userId', op: 'EQUAL', value: userId }]
      });
      console.log('[get-dj-mixes] Found', mixes.length, 'mixes with userId field');

      // If no results, try user_id field (snake_case)
      if (mixes.length === 0) {
        mixes = await queryCollection('dj-mixes', {
          filters: [{ field: 'user_id', op: 'EQUAL', value: userId }]
        });
        console.log('[get-dj-mixes] Found', mixes.length, 'mixes with user_id field');
      }

      // If still no results, try uploaderId field
      if (mixes.length === 0) {
        mixes = await queryCollection('dj-mixes', {
          filters: [{ field: 'uploaderId', op: 'EQUAL', value: userId }]
        });
        console.log('[get-dj-mixes] Found', mixes.length, 'mixes with uploaderId field');
      }

      // If still no results, try to match by user's displayName
      // First, get the user's displayName from their profile (parallel queries)
      if (mixes.length === 0) {
        try {
          const { getDocument } = await import('../../lib/firebase-rest');
          // Fetch from all collections in parallel
          const [customerProfile, userProfile, artistProfile] = await Promise.all([
            getDocument('customers', userId),
            getDocument('users', userId),
            getDocument('artists', userId)
          ]);

          // Extract displayName from whichever profile has it
          const displayName = customerProfile?.displayName ||
                             userProfile?.displayName ||
                             userProfile?.partnerInfo?.displayName ||
                             artistProfile?.artistName ||
                             artistProfile?.name;

          console.log('[get-dj-mixes] Trying to match by displayName:', displayName);

          if (displayName) {
            // Try matching by djName or dj_name or displayName
            let djMixes = await queryCollection('dj-mixes', {
              filters: [{ field: 'djName', op: 'EQUAL', value: displayName }]
            });

            if (djMixes.length === 0) {
              djMixes = await queryCollection('dj-mixes', {
                filters: [{ field: 'dj_name', op: 'EQUAL', value: displayName }]
              });
            }

            if (djMixes.length === 0) {
              djMixes = await queryCollection('dj-mixes', {
                filters: [{ field: 'displayName', op: 'EQUAL', value: displayName }]
              });
            }

            mixes = djMixes;
            console.log('[get-dj-mixes] Found', mixes.length, 'mixes by displayName match');
          }
        } catch (e) {
          console.error('[get-dj-mixes] Error matching by displayName:', e);
        }
      }
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
      artwork: mix.artwork_url || mix.artworkUrl || mix.coverUrl || mix.imageUrl || '/place-holder.webp',
      artworkUrl: mix.artwork_url || mix.artworkUrl || mix.coverUrl || mix.imageUrl || '/place-holder.webp',
      artwork_url: mix.artwork_url || mix.artworkUrl || mix.coverUrl || mix.imageUrl || '/place-holder.webp',
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
        // Don't cache user-specific data, short cache for public listings
        'Cache-Control': userId ? 'no-store, no-cache, must-revalidate' : 'public, max-age=60, s-maxage=60'
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