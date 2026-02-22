// src/pages/api/get-dj-mixes.ts
// Uses Firebase REST API - works on Cloudflare Pages (no Admin SDK)
// Uses KV caching for public listings (not user-specific)
import type { APIRoute } from 'astro';
import { queryCollection } from '../../lib/firebase-rest';
import { initKVCache, kvGet, kvSet } from '../../lib/kv-cache';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger } from '../../lib/api-utils';

export const prerender = false;

const logger = createLogger('get-dj-mixes');

// Cache config for DJ mixes (5 min)
const MIXES_CACHE = { prefix: 'mixes', ttl: 300 };

export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`get-dj-mixes:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // Initialize Firebase for Cloudflare runtime
  const env = locals.runtime.env;

  initKVCache(env);

  const url = new URL(request.url);
  const limitParam = url.searchParams.get('limit');
  const userId = url.searchParams.get('userId');
  const limit = limitParam ? parseInt(limitParam) : 50;
  const skipCache = url.searchParams.get('fresh') === '1' || url.searchParams.get('t') !== null;

  try {
    let mixes: Record<string, unknown>[] = [];

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
        skipCache: skipCache, // Skip cache after updates (t= param)
        cacheTTL: 120000 // 2 min cache when not skipping
      });

      // Filter by any userId field variation (handles schema inconsistency)
      mixes = allMixes.filter((mix: Record<string, unknown>) =>
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
            getDocument('users', userId),
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
            mixes = allMixes.filter((mix: Record<string, unknown>) => {
              const djName = (mix.djName || mix.dj_name || mix.displayName || '').toLowerCase();
              return djName === displayNameLower;
            });
          }
        } catch (e: unknown) {
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

    // Strip sensitive/internal fields before returning to client
    const sanitizedMixes = limitedMixes.map(({ userId: _uid, user_id: _uid2, uploaderId: _uid3, folder_path: _fp, ...safe }) => safe);

    const result = {
      success: true,
      mixes: sanitizedMixes,
      total: sanitizedMixes.length,
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
    
  } catch (error: unknown) {
    // Only log errors in development
    logger.error('[get-dj-mixes] Error:', error);
    return ApiErrors.serverError('Failed to fetch DJ mixes');
  }
};