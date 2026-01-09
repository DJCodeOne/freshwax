// src/pages/api/save-user-badge.ts
// Save user's Plus badge to KV storage (minimal Firebase usage)
import type { APIRoute } from 'astro';
import { getDocument, initFirebaseEnv, verifyUserToken } from '../../lib/firebase-rest';

export const prerender = false;

// KV key for user badge
const getBadgeKey = (userId: string) => `plus-badge:${userId}`;

// Valid badge options
const VALID_BADGES = [
  'crown', 'fire', 'headphones', 'skull', 'lion', 'leopard', 'palm', 'lightning',
  'vinyl', 'speaker', 'moon', 'star', 'diamond', 'snake', 'bat', 'mic', 'leaf',
  'gorilla', 'spider', 'alien'
];

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any)?.runtime?.env;
    const kv = env?.CACHE as KVNamespace | undefined;

    if (!kv) {
      return new Response(JSON.stringify({ success: false, error: 'Storage not available' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    initFirebaseEnv({
      FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
      FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
    });

    // Get auth token
    const authHeader = request.headers.get('Authorization');
    const idToken = authHeader?.replace('Bearer ', '') || undefined;

    const { userId, badge } = await request.json();

    if (!userId || !badge) {
      return new Response(JSON.stringify({ success: false, error: 'Missing userId or badge' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate badge
    if (!VALID_BADGES.includes(badge)) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid badge' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Require auth token
    if (!idToken) {
      return new Response(JSON.stringify({ success: false, error: 'Authentication required' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Verify the token matches the userId
    try {
      const tokenUserId = await verifyUserToken(idToken);
      if (tokenUserId !== userId) {
        return new Response(JSON.stringify({ success: false, error: 'User mismatch' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    } catch (e) {
      console.error('[save-user-badge] Token verification failed:', e);
      return new Response(JSON.stringify({ success: false, error: 'Invalid authentication token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check if user is Plus member (this is the only Firebase read - on save only)
    const userDoc = await getDocument('users', userId);
    if (!userDoc) {
      return new Response(JSON.stringify({ success: false, error: 'User not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    let isPro = false;
    if (userDoc.subscription?.tier === 'pro') {
      const expiresAt = userDoc.subscription.expiresAt;
      if (expiresAt) {
        const expiryDate = typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt;
        isPro = expiryDate > new Date();
      }
    }

    if (!isPro) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Only Plus members can customize their badge'
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Save badge to KV (no Firebase write, no quota impact)
    await kv.put(getBadgeKey(userId), badge, {
      expirationTtl: 365 * 24 * 60 * 60 // 1 year TTL
    });

    return new Response(JSON.stringify({
      success: true,
      badge
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[save-user-badge] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save badge'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
