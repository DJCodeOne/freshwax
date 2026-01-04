// src/pages/api/get-dj-mixes.ts
// Uses Firebase REST API - works on Cloudflare Pages (no Admin SDK)
// Uses KV caching for public listings (not user-specific)
import type { APIRoute } from 'astro';
import { queryCollection, initFirebaseEnv } from '../../lib/firebase-rest';
import { initKVCache, kvGet, kvSet } from '../../lib/kv-cache';

export const prerender = false;

// Production-safe logging - only errors in production
const isDev = import.meta.env.DEV;

// Cache config for DJ mixes (5 min)
const MIXES_CACHE = { prefix: 'mixes', ttl: 300 };

export const GET: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
  initKVCache(env);

  const url = new URL(request.url);
  const limitParam = url.searchParams.get('limit');
  const userId = url.searchParams.get('userId');
  const limit = limitParam ? parseInt(limitParam) : 50;
  const skipCache = url.searchParams.get('fresh') === '1';

  try {
    let mixes: any[] = [];

    // Only cache public listings (not user-specific)
    const cacheKey = `public:${limit}`;
    if (!userId && !skipCache) {
      const cached = await kvGet(cacheKey, MIXES_CACHE);
      if (cached) {
        return new Response(JSON.stringify(cached), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=60, s-maxage=60'
          }
        });
      }
    }

    // If userId provided, filter by userId
    if (userId) {
      // OPTIMIZED: Single query with in-memory filtering (1 read instead of 3-6)
      // This is more efficient because:
      // 1. One query with cache vs 3+ uncacheable filtered queries
      // 2. Firestore REST API doesn't support OR queries, so we filter client-side
      const allMixes = await queryCollection('dj-mixes', {
        limit: 500,
        cacheTime: 120000 // 2 min cache - shared across all user lookups
      });

      // Filter by any userId field variation (handles schema inconsistency)
      mixes = allMixes.filter((mix: any) =>
        mix.userId === userId ||
        mix.user_id === userId ||
        mix.uploaderId === userId
      );

      // If no results by userId, try matching by displayName
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

          if (displayName) {
            // Filter cached mixes by displayName variations
            const displayNameLower = displayName.toLowerCase();
            mixes = allMixes.filter((mix: any) => {
              const djName = (mix.djName || mix.dj_name || mix.displayName || '').toLowerCase();
              return djName === displayNameLower;
            });
          }
        } catch (e) {
          // Silently fail - no mixes found for this user
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
        mixes = await queryCollection('dj-mixes', { limit });
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

    const result = {
      success: true,
      mixes: limitedMixes,
      total: limitedMixes.length,
      source: 'firebase-rest'
    };

    // Cache public listings in KV (5 min), skip for user-specific
    if (!userId) {
      kvSet(cacheKey, result, MIXES_CACHE);
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Don't cache user-specific data, short cache for public listings
        'Cache-Control': userId ? 'no-store, no-cache, must-revalidate' : 'public, max-age=60, s-maxage=60'
      }
    });
    
  } catch (error) {
    // Only log errors in development
    if (isDev) console.error('[get-dj-mixes] Error:', error);
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