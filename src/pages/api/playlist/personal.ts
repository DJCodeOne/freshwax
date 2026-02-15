// src/pages/api/playlist/personal.ts
// Personal playlist API - save/load user's personal playlist to D1
// All users get cloud sync: Standard = 100 tracks, Plus = 1000 tracks

import type { APIContext } from 'astro';
import { getDocument } from '../../../lib/firebase-rest';
import { getEffectiveTier, SUBSCRIPTION_TIERS, TIER_LIMITS } from '../../../lib/subscription';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

function initEnv(locals: App.Locals) {
  const env = locals.runtime.env;
}

// Get user's subscription tier and track limit
async function getUserTierInfo(userId: string): Promise<{ tier: string; isPlus: boolean; trackLimit: number }> {
  try {
    const userDoc = await getDocument('users', userId);
    if (!userDoc) {
      return { tier: 'free', isPlus: false, trackLimit: TIER_LIMITS[SUBSCRIPTION_TIERS.FREE].playlistTrackLimit };
    }
    const tier = getEffectiveTier(userDoc.subscription);
    const isPlus = tier === SUBSCRIPTION_TIERS.PRO;
    const trackLimit = TIER_LIMITS[tier].playlistTrackLimit;
    return { tier, isPlus, trackLimit };
  } catch (error) {
    console.error('[PersonalPlaylist] Error checking subscription:', error);
    return { tier: 'free', isPlus: false, trackLimit: TIER_LIMITS[SUBSCRIPTION_TIERS.FREE].playlistTrackLimit };
  }
}

// GET - Load user's personal playlist from D1
export async function GET({ request, locals }: APIContext) {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`playlist-personal:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    initEnv(locals);
    const env = locals.runtime.env;
    const db = env?.DB;

    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');

    if (!userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing userId'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get user tier info
    const { isPlus, trackLimit } = await getUserTierInfo(userId);

    // Load from D1
    if (!db) {
      console.error('[PersonalPlaylist] D1 database not available');
      return new Response(JSON.stringify({
        success: true,
        playlist: [],
        isPlus,
        trackLimit,
        error: 'Database not available'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const result = await db.prepare(
      'SELECT playlist FROM user_playlists WHERE user_id = ?'
    ).bind(userId).first();

    let playlist: any[] = [];
    if (result && result.playlist) {
      try {
        playlist = JSON.parse(result.playlist as string);
      } catch (e) {
        console.error('[PersonalPlaylist] Error parsing playlist JSON:', e);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      playlist,
      isPlus,
      trackLimit
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    console.error('[PersonalPlaylist] GET error:', error instanceof Error ? error.message : String(error));
    return new Response(JSON.stringify({
      success: false,
      error: 'Internal error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// POST - Save user's personal playlist to D1
export async function POST({ request, locals }: APIContext) {
  // Rate limit: write operations - 30 per minute
  const clientId2 = getClientId(request);
  const rl = checkRateLimit(`playlist-personal-write:${clientId2}`, RateLimiters.write);
  if (!rl.allowed) {
    return rateLimitResponse(rl.retryAfter!);
  }

  try {
    initEnv(locals);
    const env = locals.runtime.env;
    const db = env?.DB;

    // SECURITY: Verify the requesting user owns this playlist
    const authHeader = request.headers.get('Authorization');
    const idToken = authHeader?.replace('Bearer ', '') || undefined;

    const body = await request.json();
    const { userId, items } = body;

    if (!userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing userId'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Verify user token matches userId
    const { verifyUserToken } = await import('../../../lib/firebase-rest');
    if (!idToken) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Authentication required'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const tokenUserId = await verifyUserToken(idToken);
    if (!tokenUserId || tokenUserId !== userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'You can only save your own playlist'
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!Array.isArray(items)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Items must be an array'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get user tier info and enforce track limit
    const { isPlus, trackLimit } = await getUserTierInfo(userId);

    if (items.length > trackLimit) {
      const upgradeMsg = !isPlus ? ' Go Plus for up to 1,000 tracks.' : '';
      return new Response(JSON.stringify({
        success: false,
        error: `Playlist exceeds ${trackLimit} track limit.${upgradeMsg}`,
        isPlus,
        trackLimit
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Save to D1
    if (!db) {
      console.error('[PersonalPlaylist] D1 database not available');
      return new Response(JSON.stringify({
        success: false,
        error: 'Database not available'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const playlistJson = JSON.stringify(items);
    const now = new Date().toISOString();

    // Upsert: Insert or replace
    await db.prepare(
      `INSERT INTO user_playlists (user_id, playlist, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET playlist = excluded.playlist, updated_at = excluded.updated_at`
    ).bind(userId, playlistJson, now).run();

    console.log('[PersonalPlaylist] Saved to D1 for user:', userId, 'items:', items.length);

    return new Response(JSON.stringify({
      success: true,
      message: 'Playlist saved to cloud',
      isPlus,
      trackLimit
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    console.error('[PersonalPlaylist] POST error:', error instanceof Error ? error.message : String(error));
    return new Response(JSON.stringify({
      success: false,
      error: 'Internal error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
