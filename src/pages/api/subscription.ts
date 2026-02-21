// src/pages/api/subscription.ts
// Subscription management API - check limits, get status, upgrade
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, setDocument, updateDocument, queryCollection, verifyRequestUser } from '../../lib/firebase-rest';
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
import { isAdmin, initAdminEnv } from '../../lib/admin';
import { fetchWithTimeout, errorResponse, ApiErrors, createLogger } from '../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

export const prerender = false;

const logger = createLogger('subscription');

// Zod schemas for subscription endpoints
const SubscriptionGetSchema = z.object({
  userId: z.string().min(1, 'userId required'),
  action: z.enum(['status', 'canUploadMix', 'canStream']).default('status'),
});

const SubscriptionPostSchema = z.object({
  action: z.enum(['recordMixUpload', 'recordStreamTime', 'activatePro']),
  userId: z.string().min(1, 'userId required'),
  minutes: z.number().int().positive().optional(),
  paymentId: z.string().min(1).optional(),
  paymentMethod: z.enum(['stripe', 'paypal']).optional(),
  userName: z.string().optional(),
}).passthrough();

// GET: Check subscription status and limits
export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`subscription-get:${clientId}`, RateLimiters.strict);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals?.runtime?.env;

  initAdminEnv(env);

  const url = new URL(request.url);
  const rawParams = {
    userId: url.searchParams.get('userId') || '',
    action: url.searchParams.get('action') || 'status',
  };

  const paramResult = SubscriptionGetSchema.safeParse(rawParams);
  if (!paramResult.success) {
    return ApiErrors.badRequest('Invalid request');
  }
  const { userId, action } = paramResult.data;

  // Verify the authenticated user matches the requested userId
  const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
  if (authError || !verifiedUserId) {
    return ApiErrors.unauthorized('Authentication required');
  }

  if (verifiedUserId !== userId) {
    return ApiErrors.forbidden('You can only view your own subscription');
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
      // Admin bypass - admins have unlimited uploads
      const userIsAdmin = await isAdmin(userId);
      if (userIsAdmin) {
        return new Response(JSON.stringify({
          success: true,
          allowed: true,
          remaining: Infinity,
          tier: 'admin',
          uploadsThisWeek: usage.mixUploadsThisWeek,
          weeklyLimit: 'unlimited'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

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
      // Admin bypass - admins have unlimited streaming
      const userIsAdmin = await isAdmin(userId);
      if (userIsAdmin) {
        return new Response(JSON.stringify({
          success: true,
          allowed: true,
          remainingMinutes: Infinity,
          tier: 'admin',
          minutesUsedToday: usage.streamMinutesToday,
          dailyLimitMinutes: 'unlimited'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      const result = canBookStreamSlot(effectiveTier, usage);
      return new Response(JSON.stringify({
        success: true,
        ...result,
        tier: effectiveTier,
        minutesUsedToday: usage.streamMinutesToday,
        dailyLimitMinutes: limits.streamHoursPerDay * 60
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Check if user was Plus but expired (for renewal prompts)
    const wasPlus = subscription.tier === SUBSCRIPTION_TIERS.PRO;
    const isExpired = wasPlus && subscription.expiresAt && new Date(subscription.expiresAt) <= new Date();
    const isExpiringSoon = wasPlus && subscription.expiresAt && !isExpired &&
      new Date(subscription.expiresAt) <= new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // Within 7 days

    // Default: return full status
    return new Response(JSON.stringify({
      success: true,
      subscription: {
        tier: effectiveTier,
        tierName: limits.name,
        isPro: effectiveTier === SUBSCRIPTION_TIERS.PRO,
        wasPlus,
        isExpired,
        isExpiringSoon,
        expiresAt: subscription.expiresAt,
        subscribedAt: subscription.subscribedAt,
        plusId: subscription.plusId,
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

  } catch (error: unknown) {
    logger.error('Error:', error);
    return ApiErrors.serverError('Failed to check subscription');
  }
};

// POST: Record usage or upgrade subscription
export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`subscription-post:${clientId}`, RateLimiters.strict);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals?.runtime?.env;

  initAdminEnv(env);

  const authHeader = request.headers.get('Authorization');
  const idToken = authHeader?.replace('Bearer ', '') || undefined;

  try {
    const rawBody = await request.json();

    const parseResult = SubscriptionPostSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { action, userId, ...data } = parseResult.data;

    // SECURITY: Verify the requesting user owns this userId
    const { verifyUserToken } = await import('../../lib/firebase-rest');
    if (!idToken) {
      return ApiErrors.unauthorized('Authentication required');
    }
    const tokenUserId = await verifyUserToken(idToken);
    if (!tokenUserId || tokenUserId !== userId) {
      return ApiErrors.forbidden('You can only modify your own subscription data');
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

      logger.info('Recorded mix upload for', userId, '- count:', uploadsThisWeek + 1);

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

      logger.info('Recorded stream time for', userId, '- total minutes today:', minutesToday + (minutes || 60));

      return new Response(JSON.stringify({
        success: true,
        minutesToday: minutesToday + (minutes || 60)
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Action: Activate Pro subscription (after payment)
    if (action === 'activatePro') {
      const { paymentId, paymentMethod, userName } = data;

      if (!paymentId) {
        return ApiErrors.badRequest('Payment ID required');
      }

      // SECURITY: Verify payment is real and completed before activating Pro
      const env = locals.runtime.env;
      const method = paymentMethod || 'stripe';

      if (method === 'stripe') {
        const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
        if (!stripeSecretKey) {
          return ApiErrors.serverError('Payment verification unavailable');
        }
        try {
          const Stripe = (await import('stripe')).default;
          const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' as any });

          if (paymentId.startsWith('pi_')) {
            const pi = await stripe.paymentIntents.retrieve(paymentId);
            if (pi.status !== 'succeeded') {
              return errorResponse('Payment not completed', 402);
            }
            // Verify payment amount matches Pro price (amount is in pence)
            if (pi.amount < PRO_ANNUAL_PRICE * 100) {
              logger.error('Payment amount too low:', pi.amount, 'expected at least', PRO_ANNUAL_PRICE * 100);
              return errorResponse('Payment amount insufficient', 402);
            }
          } else if (paymentId.startsWith('cs_')) {
            const session = await stripe.checkout.sessions.retrieve(paymentId);
            if (session.payment_status !== 'paid') {
              return errorResponse('Payment not completed', 402);
            }
            // Verify session amount matches Pro price (amount_total is in pence)
            if ((session.amount_total || 0) < PRO_ANNUAL_PRICE * 100) {
              logger.error('Session amount too low:', session.amount_total, 'expected at least', PRO_ANNUAL_PRICE * 100);
              return errorResponse('Payment amount insufficient', 402);
            }
          } else {
            return ApiErrors.badRequest('Invalid payment ID format');
          }
        } catch (stripeErr: unknown) {
          logger.error('Stripe verification failed:', stripeErr instanceof Error ? stripeErr.message : String(stripeErr));
          return errorResponse('Payment verification failed', 402);
        }
      } else if (method === 'paypal') {
        const paypalClientId = env?.PAYPAL_CLIENT_ID || import.meta.env.PAYPAL_CLIENT_ID;
        const paypalSecret = env?.PAYPAL_SECRET || import.meta.env.PAYPAL_SECRET;
        const paypalMode = env?.PAYPAL_MODE || import.meta.env.PAYPAL_MODE || 'sandbox';
        const paypalBase = paypalMode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

        if (!paypalClientId || !paypalSecret) {
          return ApiErrors.serverError('Payment verification unavailable');
        }
        try {
          const authResponse = await fetchWithTimeout(`${paypalBase}/v1/oauth2/token`, {
            method: 'POST',
            headers: {
              'Authorization': 'Basic ' + btoa(`${paypalClientId}:${paypalSecret}`),
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials'
          }, 10000);
          const authData = await authResponse.json();
          const orderResponse = await fetchWithTimeout(`${paypalBase}/v2/checkout/orders/${paymentId}`, {
            headers: { 'Authorization': `Bearer ${authData.access_token}` }
          }, 10000);
          const orderData = await orderResponse.json();
          if (orderData.status !== 'COMPLETED') {
            return errorResponse('PayPal payment not completed', 402);
          }
          // Verify PayPal amount matches Pro price
          const ppAmount = parseFloat(orderData.purchase_units?.[0]?.amount?.value || '0');
          if (ppAmount < PRO_ANNUAL_PRICE) {
            logger.error('PayPal amount too low:', ppAmount, 'expected at least', PRO_ANNUAL_PRICE);
            return errorResponse('Payment amount insufficient', 402);
          }
        } catch (paypalErr: unknown) {
          logger.error('PayPal verification failed:', paypalErr instanceof Error ? paypalErr.message : String(paypalErr));
          return errorResponse('Payment verification failed', 402);
        }
      } else {
        return ApiErrors.badRequest('Unknown payment method');
      }

      // SECURITY: Prevent payment ID reuse across users
      const existingUsers = await queryCollection('users', {
        filters: [{ field: 'subscription.subscriptionId', op: 'EQUAL', value: paymentId }],
        limit: 1
      });
      if (existingUsers.length > 0 && existingUsers[0].id !== userId) {
        logger.error('Payment ID already used by another user:', paymentId);
        return ApiErrors.badRequest('Payment already used');
      }

      logger.info('Payment verified for', userId, '- paymentId:', paymentId, '- method:', method);

      const now = new Date();
      const expiresAt = new Date(now);
      expiresAt.setFullYear(expiresAt.getFullYear() + 1); // 1 year subscription

      // Generate Plus ID
      const year = now.getFullYear().toString().slice(-2);
      const month = (now.getMonth() + 1).toString().padStart(2, '0');
      const day = now.getDate().toString().padStart(2, '0');
      const userHash = userId.slice(-4).toUpperCase();
      const plusId = `FWP-${year}${month}${day}-${userHash}`;

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
          subscriptionId: paymentId,
          plusId,
          paymentMethod: paymentMethod || 'stripe',
        },
        referralCode: referralGiftCard.code, // Store the referral code for easy access
        referralCodeId: referralCardId
      }, idToken);

      logger.info('Activated Pro for', userId, '- expires:', expiresAt.toISOString(), '- referral code:', referralGiftCard.code);

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

    return ApiErrors.badRequest('Unknown action');

  } catch (error: unknown) {
    logger.error('Error:', error);
    return ApiErrors.serverError('Failed to process request');
  }
};
