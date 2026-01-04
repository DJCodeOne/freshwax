// src/pages/api/playlist/skip.ts
// Handle !skip command - checks Plus subscription and daily limit

import type { APIContext } from 'astro';
import { getDocument, updateDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { getEffectiveTier, canSkipTrack, SUBSCRIPTION_TIERS, getTodayDate } from '../../../lib/subscription';
import { getAdminUids, initAdminEnv } from '../../../lib/admin';

export const prerender = false;

function initEnv(locals: any) {
  const env = (locals as any).runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || env?.PUBLIC_FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || env?.PUBLIC_FIREBASE_API_KEY || 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g',
  });
  // Initialize admin config from runtime env
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
}

// POST - Request to skip a track
export async function POST({ request, locals }: APIContext) {
  try {
    initEnv(locals);

    // SECURITY: Get userId from verified token, not request body
    const { verifyRequestUser } = await import('../../../lib/firebase-rest');
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Authentication required'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Admins can always skip
    if (getAdminUids().includes(userId)) {
      return new Response(JSON.stringify({
        success: true,
        allowed: true,
        isAdmin: true,
        message: 'Admin skip'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get user data
    const userDoc = await getDocument('users', userId);
    if (!userDoc) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check subscription tier
    const tier = getEffectiveTier(userDoc.subscription);

    // Standard users cannot skip
    if (tier === SUBSCRIPTION_TIERS.FREE) {
      return new Response(JSON.stringify({
        success: true,
        allowed: false,
        reason: '!skip is a Plus member feature. Upgrade to Plus for 3 skips per day!',
        isPlus: false
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Plus user - check daily limit
    const today = getTodayDate();
    const usage = userDoc.usage || {};

    // Reset count if new day
    const skipsUsedToday = usage.skipDate === today ? (usage.skipsUsedToday || 0) : 0;

    // Check if can skip
    const skipCheck = canSkipTrack(tier, skipsUsedToday);

    if (!skipCheck.allowed) {
      return new Response(JSON.stringify({
        success: true,
        allowed: false,
        reason: skipCheck.reason,
        limit: skipCheck.limit,
        remaining: skipCheck.remaining,
        isPlus: true
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Increment skip count
    const newSkipCount = skipsUsedToday + 1;
    await updateDocument('users', userId, {
      'usage.skipsUsedToday': newSkipCount,
      'usage.skipDate': today
    });

    return new Response(JSON.stringify({
      success: true,
      allowed: true,
      remaining: skipCheck.remaining - 1,
      limit: skipCheck.limit,
      isPlus: true,
      message: `Skip used! ${skipCheck.remaining - 1} remaining today.`
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[Skip API] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// GET - Check skip status without using a skip
export async function GET({ request, locals }: APIContext) {
  try {
    initEnv(locals);

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

    // Admins have unlimited skips
    if (getAdminUids().includes(userId)) {
      return new Response(JSON.stringify({
        success: true,
        canSkip: true,
        isAdmin: true,
        remaining: 'unlimited'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get user data
    const userDoc = await getDocument('users', userId);
    if (!userDoc) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check subscription tier
    const tier = getEffectiveTier(userDoc.subscription);

    if (tier === SUBSCRIPTION_TIERS.FREE) {
      return new Response(JSON.stringify({
        success: true,
        canSkip: false,
        isPlus: false,
        reason: '!skip is a Plus feature'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Plus user - check remaining skips
    const today = getTodayDate();
    const usage = userDoc.usage || {};
    const skipsUsedToday = usage.skipDate === today ? (usage.skipsUsedToday || 0) : 0;
    const skipCheck = canSkipTrack(tier, skipsUsedToday);

    return new Response(JSON.stringify({
      success: true,
      canSkip: skipCheck.allowed,
      isPlus: true,
      limit: skipCheck.limit,
      remaining: skipCheck.remaining,
      used: skipsUsedToday
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[Skip API] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
