// src/pages/api/subscription.ts
// Subscription management API - check limits, get status, upgrade
import type { APIRoute } from 'astro';
import { getDocument, setDocument, updateDocument, queryCollection, initFirebaseEnv } from '../../lib/firebase-rest';
import {
  SUBSCRIPTION_TIERS,
  TIER_LIMITS,
  PRO_ANNUAL_PRICE,
  getWeekStart,
  getTodayDate,
  getEffectiveTier,
  canUploadMix,
  canBookStreamSlot,
  getTierBenefits,
  type UserSubscription,
  type UserUsage
} from '../../lib/subscription';
import { createReferralGiftCard } from '../../lib/giftcard';

export const prerender = false;

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log('[subscription]', ...args),
  error: (...args: any[]) => console.error('[subscription]', ...args),
};

function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

// GET: Check subscription status and limits
export const GET: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);

  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  const action = url.searchParams.get('action') || 'status';

  if (!userId) {
    return new Response(JSON.stringify({ success: false, error: 'userId required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Fetch user's subscription and usage data
    const [userDoc, usageDoc] = await Promise.all([
      getDocument('users', userId),
      getDocument('userUsage', userId)
    ]);

    const subscription: UserSubscription = userDoc?.subscription || { tier: SUBSCRIPTION_TIERS.FREE };
    const effectiveTier = getEffectiveTier(subscription);

    const usage: UserUsage = usageDoc || {
      mixUploadsThisWeek: 0,
      weekStartDate: getWeekStart(),
      streamMinutesToday: 0,
      dayDate: getTodayDate()
    };

    // Reset usage counters if period has changed
    const currentWeekStart = getWeekStart();
    const currentDay = getTodayDate();

    if (usage.weekStartDate !== currentWeekStart) {
      usage.mixUploadsThisWeek = 0;
      usage.weekStartDate = currentWeekStart;
    }
    if (usage.dayDate !== currentDay) {
      usage.streamMinutesToday = 0;
      usage.dayDate = currentDay;
    }

    const limits = TIER_LIMITS[effectiveTier];

    // Action: check if can upload mix
    if (action === 'canUploadMix') {
      const result = canUploadMix(effectiveTier, usage);
      return new Response(JSON.stringify({
        success: true,
        ...result,
        tier: effectiveTier,
        uploadsThisWeek: usage.mixUploadsThisWeek,
        weeklyLimit: limits.mixUploadsPerWeek
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Action: check if can book stream slot
    if (action === 'canStream') {
      const result = canBookStreamSlot(effectiveTier, usage);
      return new Response(JSON.stringify({
        success: true,
        ...result,
        tier: effectiveTier,
        minutesUsedToday: usage.streamMinutesToday,
        dailyLimitMinutes: limits.streamHoursPerDay * 60
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Default: return full status
    return new Response(JSON.stringify({
      success: true,
      subscription: {
        tier: effectiveTier,
        tierName: limits.name,
        isPro: effectiveTier === SUBSCRIPTION_TIERS.PRO,
        expiresAt: subscription.expiresAt,
        subscribedAt: subscription.subscribedAt,
      },
      usage: {
        mixUploadsThisWeek: usage.mixUploadsThisWeek,
        mixUploadsRemaining: limits.mixUploadsPerWeek === Infinity
          ? 'unlimited'
          : Math.max(0, limits.mixUploadsPerWeek - usage.mixUploadsThisWeek),
        streamMinutesToday: usage.streamMinutesToday,
        streamMinutesRemaining: (limits.streamHoursPerDay * 60) - usage.streamMinutesToday,
      },
      limits: {
        mixUploadsPerWeek: limits.mixUploadsPerWeek === Infinity ? 'unlimited' : limits.mixUploadsPerWeek,
        streamHoursPerDay: limits.streamHoursPerDay,
        maxConcurrentSlots: limits.maxConcurrentSlots,
      },
      benefits: getTierBenefits(effectiveTier),
      upgrade: effectiveTier === SUBSCRIPTION_TIERS.FREE ? {
        price: PRO_ANNUAL_PRICE,
        priceFormatted: `£${PRO_ANNUAL_PRICE}/year`,
        benefits: getTierBenefits(SUBSCRIPTION_TIERS.PRO),
      } : null
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    log.error('Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to check subscription'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// POST: Record usage or upgrade subscription
export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);

  const authHeader = request.headers.get('Authorization');
  const idToken = authHeader?.replace('Bearer ', '') || undefined;

  try {
    const { action, userId, ...data } = await request.json();

    if (!userId) {
      return new Response(JSON.stringify({ success: false, error: 'userId required' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    // Action: Record a mix upload
    if (action === 'recordMixUpload') {
      const usageDoc = await getDocument('userUsage', userId) || {
        mixUploadsThisWeek: 0,
        weekStartDate: getWeekStart(),
        streamMinutesToday: 0,
        dayDate: getTodayDate()
      };

      const currentWeekStart = getWeekStart();
      let uploadsThisWeek = usageDoc.mixUploadsThisWeek || 0;

      // Reset if new week
      if (usageDoc.weekStartDate !== currentWeekStart) {
        uploadsThisWeek = 0;
      }

      await setDocument('userUsage', userId, {
        ...usageDoc,
        mixUploadsThisWeek: uploadsThisWeek + 1,
        weekStartDate: currentWeekStart,
        lastMixUpload: new Date().toISOString()
      }, idToken);

      log.info('Recorded mix upload for', userId, '- count:', uploadsThisWeek + 1);

      return new Response(JSON.stringify({
        success: true,
        uploadsThisWeek: uploadsThisWeek + 1
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Action: Record stream time
    if (action === 'recordStreamTime') {
      const { minutes } = data;
      const usageDoc = await getDocument('userUsage', userId) || {
        mixUploadsThisWeek: 0,
        weekStartDate: getWeekStart(),
        streamMinutesToday: 0,
        dayDate: getTodayDate()
      };

      const currentDay = getTodayDate();
      let minutesToday = usageDoc.streamMinutesToday || 0;

      // Reset if new day
      if (usageDoc.dayDate !== currentDay) {
        minutesToday = 0;
      }

      await setDocument('userUsage', userId, {
        ...usageDoc,
        streamMinutesToday: minutesToday + (minutes || 60),
        dayDate: currentDay,
        lastStreamAt: new Date().toISOString()
      }, idToken);

      log.info('Recorded stream time for', userId, '- total minutes today:', minutesToday + (minutes || 60));

      return new Response(JSON.stringify({
        success: true,
        minutesToday: minutesToday + (minutes || 60)
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Action: Activate Pro subscription (after payment)
    if (action === 'activatePro') {
      const { paymentId, paymentMethod, userName } = data;
      const now = new Date();
      const expiresAt = new Date(now);
      expiresAt.setFullYear(expiresAt.getFullYear() + 1); // 1 year subscription

      const userDoc = await getDocument('users', userId) || {};

      // Generate a referral code for this Pro user (one-time, 50% off for a friend)
      const referralGiftCard = createReferralGiftCard(userId, userName || userDoc.displayName);

      // Save the referral gift card
      const referralCardId = `ref_${userId}_${Date.now()}`;
      await setDocument('giftCards', referralCardId, {
        ...referralGiftCard,
        id: referralCardId
      });

      await setDocument('users', userId, {
        ...userDoc,
        subscription: {
          tier: SUBSCRIPTION_TIERS.PRO,
          subscribedAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
          paymentId,
          paymentMethod: paymentMethod || 'stripe',
        },
        referralCode: referralGiftCard.code, // Store the referral code for easy access
        referralCodeId: referralCardId
      }, idToken);

      log.info('Activated Pro for', userId, '- expires:', expiresAt.toISOString(), '- referral code:', referralGiftCard.code);

      return new Response(JSON.stringify({
        success: true,
        message: 'Pro subscription activated!',
        subscription: {
          tier: SUBSCRIPTION_TIERS.PRO,
          tierName: 'Pro',
          expiresAt: expiresAt.toISOString()
        },
        referralCode: referralGiftCard.code,
        referralMessage: 'Share this code with a friend - they get 50% off their Pro upgrade!'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ success: false, error: 'Unknown action' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    log.error('Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to process request'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
