// src/pages/api/playlist/personal.ts
// Personal playlist API - save/load user's personal playlist to D1
// Cloud sync is a Plus-only feature - Standard users only have local storage

import type { APIContext } from 'astro';
import { getDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { getEffectiveTier, SUBSCRIPTION_TIERS } from '../../../lib/subscription';

function initEnv(locals: any) {
  const env = (locals as any).runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || env?.PUBLIC_FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || env?.PUBLIC_FIREBASE_API_KEY || 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g',
  });
}

// Check if user has Plus subscription (still uses Firebase for user data)
async function isUserPlus(userId: string): Promise<boolean> {
  try {
    const userDoc = await getDocument('users', userId);
    if (!userDoc) return false;
    const tier = getEffectiveTier(userDoc.subscription);
    return tier === SUBSCRIPTION_TIERS.PRO;
  } catch (error) {
    console.error('[PersonalPlaylist] Error checking subscription:', error);
    return false;
  }
}

// GET - Load user's personal playlist from D1 (Plus only - returns empty for Standard)
export async function GET({ request, locals }: APIContext) {
  try {
    initEnv(locals);
    const env = (locals as any).runtime?.env;
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

    // Check if user has Plus subscription for cloud sync
    const hasPlus = await isUserPlus(userId);
    if (!hasPlus) {
      return new Response(JSON.stringify({
        success: true,
        playlist: [],
        isPlus: false,
        message: 'Cloud playlist sync is a Plus feature'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Load from D1
    if (!db) {
      console.error('[PersonalPlaylist] D1 database not available');
      return new Response(JSON.stringify({
        success: true,
        playlist: [],
        isPlus: true,
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
      isPlus: true
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('[PersonalPlaylist] GET error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// POST - Save user's personal playlist to D1 (Plus only)
export async function POST({ request, locals }: APIContext) {
  try {
    initEnv(locals);
    const env = (locals as any).runtime?.env;
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

    // Check if user has Plus subscription for cloud sync
    const hasPlus = await isUserPlus(userId);
    if (!hasPlus) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Cloud playlist sync is a Plus feature. Upgrade to Plus to sync your playlist across devices.',
        isPlus: false
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Enforce 1000 track limit for Plus users
    if (items.length > 1000) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Playlist exceeds 1,000 track limit'
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
      isPlus: true
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('[PersonalPlaylist] POST error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
