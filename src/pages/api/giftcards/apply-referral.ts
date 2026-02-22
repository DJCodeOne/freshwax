// src/pages/api/giftcards/apply-referral.ts
// Apply a referral code to a Pro subscription upgrade

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, setDocument, queryCollection, verifyRequestUser } from '../../../lib/firebase-rest';
import { isValidCodeFormat, isExpired, formatGBP, REFERRAL_DISCOUNT_AMOUNT } from '../../../lib/giftcard';
import { SUBSCRIPTION_TIERS, PRO_ANNUAL_PRICE } from '../../../lib/subscription';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { createLogger, ApiErrors } from '../../../lib/api-utils';

const log = createLogger('[apply-referral]');

// Zod schemas for referral endpoints
const ReferralGetSchema = z.object({
  code: z.string().min(1, 'Referral code is required'),
});

const ReferralPostSchema = z.object({
  code: z.string().min(1, 'Referral code is required').max(50),
  userId: z.string().optional(),
  paymentId: z.string().optional(),
  userName: z.string().optional(),
}).passthrough();

export const prerender = false;

// GET: Validate a referral code
export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard (60 req/min)
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`apply-referral:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;

  const url = new URL(request.url);
  const rawParams = { code: url.searchParams.get('code') || '' };
  const paramResult = ReferralGetSchema.safeParse(rawParams);
  if (!paramResult.success) {
    return ApiErrors.badRequest('Invalid request');
  }
  const code = paramResult.data.code;

  const normalizedCode = code.toUpperCase().trim();

  if (!isValidCodeFormat(normalizedCode)) {
    return ApiErrors.badRequest('Invalid code format');
  }

  try {
    const giftCardResults = await queryCollection('giftCards', {
      filters: [{ field: 'code', op: 'EQUAL', value: normalizedCode }],
      limit: 1
    });

    if (giftCardResults.length === 0) {
      return ApiErrors.notFound('Code not found');
    }

    const giftCard = giftCardResults[0];

    // Check if it's a referral code
    if (giftCard.restrictedTo !== 'pro_upgrade') {
      return ApiErrors.badRequest('This is not a referral code. Please use it on the gift card redemption page instead.');
    }

    // Check if already redeemed
    if (giftCard.redeemedBy) {
      return ApiErrors.badRequest('This referral code has already been used');
    }

    // Check if active
    if (!giftCard.isActive) {
      return ApiErrors.badRequest('This referral code is no longer active');
    }

    // Check if expired
    if (isExpired(giftCard.expiresAt)) {
      return ApiErrors.badRequest('This referral code has expired');
    }

    return successResponse({ valid: true,
      referrerFound: true,
      discount: giftCard.currentBalance,
      discountFormatted: formatGBP(giftCard.currentBalance),
      originalPrice: PRO_ANNUAL_PRICE,
      discountedPrice: PRO_ANNUAL_PRICE - giftCard.currentBalance,
      discountedPriceFormatted: formatGBP(PRO_ANNUAL_PRICE - giftCard.currentBalance),
      message: `Referral code valid! You'll pay ${formatGBP(PRO_ANNUAL_PRICE - giftCard.currentBalance)} instead of ${formatGBP(PRO_ANNUAL_PRICE)}` });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to validate referral code');
  }
};

// POST: Apply referral code and activate Pro subscription
export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard (60 req/min)
  const postClientId = getClientId(request);
  const postRateLimit = checkRateLimit(`apply-referral-post:${postClientId}`, RateLimiters.standard);
  if (!postRateLimit.allowed) {
    return rateLimitResponse(postRateLimit.retryAfter!);
  }

  const env = locals.runtime.env;

  try {
    // Verify the user is authenticated
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
    if (authError || !verifiedUserId) {
      return ApiErrors.unauthorized('Authentication required');
    }

    const rawBody = await request.json();

    const parseResult = ReferralPostSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { code, userId, paymentId, userName } = parseResult.data;

    // Verify the authenticated user matches the userId in the request
    if (userId && verifiedUserId !== userId) {
      return ApiErrors.forbidden('You can only apply referral codes to your own account');
    }

    // Use the verified userId for all operations
    const authenticatedUserId = verifiedUserId;

    const normalizedCode = code.toUpperCase().trim();

    // Validate code format
    if (!isValidCodeFormat(normalizedCode)) {
      return ApiErrors.badRequest('Invalid referral code format');
    }

    // Find the gift card
    const giftCardResults = await queryCollection('giftCards', {
      filters: [{ field: 'code', op: 'EQUAL', value: normalizedCode }],
      limit: 1
    });

    if (giftCardResults.length === 0) {
      return ApiErrors.notFound('Referral code not found');
    }

    const giftCard = giftCardResults[0];
    const giftCardId = giftCard.id;

    // Validate it's a referral code
    if (giftCard.restrictedTo !== 'pro_upgrade') {
      return ApiErrors.badRequest('This is not a valid referral code');
    }

    // Check if user is trying to use their own referral code
    if (giftCard.createdByUserId === authenticatedUserId) {
      return ApiErrors.badRequest('You cannot use your own referral code');
    }

    // Standard validation checks
    if (giftCard.redeemedBy) {
      return ApiErrors.badRequest('This referral code has already been used');
    }

    if (!giftCard.isActive) {
      return ApiErrors.badRequest('This referral code is no longer active');
    }

    if (isExpired(giftCard.expiresAt)) {
      return ApiErrors.badRequest('This referral code has expired');
    }

    // Check if user already has Pro
    const userDoc = await getDocument('users', authenticatedUserId) || {};
    if (userDoc.subscription?.tier === SUBSCRIPTION_TIERS.PRO) {
      const expiresAt = userDoc.subscription.expiresAt;
      if (!expiresAt || new Date(expiresAt) > new Date()) {
        return ApiErrors.badRequest('You already have an active Pro subscription');
      }
    }

    const now = new Date();
    const nowISO = now.toISOString();
    const expiresAt = new Date(now);
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);

    // Mark the referral code as redeemed
    await updateDocument('giftCards', giftCardId, {
      redeemedBy: authenticatedUserId,
      redeemedAt: nowISO,
      currentBalance: 0,
      isActive: false
    });

    // Import the createReferralGiftCard to give the new Pro user their own referral code
    const { createReferralGiftCard } = await import('../../../lib/giftcard');
    const newUserReferralCard = createReferralGiftCard(authenticatedUserId, userName || userDoc.displayName);

    // Save the new referral gift card
    const newReferralCardId = `ref_${authenticatedUserId}_${Date.now()}`;
    await setDocument('giftCards', newReferralCardId, {
      ...newUserReferralCard,
      id: newReferralCardId
    });

    // Activate Pro subscription
    await setDocument('users', authenticatedUserId, {
      ...userDoc,
      subscription: {
        tier: SUBSCRIPTION_TIERS.PRO,
        subscribedAt: nowISO,
        expiresAt: expiresAt.toISOString(),
        paymentId: paymentId || `referral_${giftCardId}`,
        paymentMethod: 'referral_discount',
        referralCodeUsed: normalizedCode,
        referrerUserId: giftCard.createdByUserId
      },
      referralCode: newUserReferralCard.code,
      referralCodeId: newReferralCardId
    });

    // Notify the referrer (optional - could add email notification here)
    log.info('Referral code used:', normalizedCode, 'by user:', authenticatedUserId, 'referrer:', giftCard.createdByUserId);

    return successResponse({ message: 'Pro subscription activated with referral discount!',
      discount: giftCard.currentBalance,
      pricePaid: PRO_ANNUAL_PRICE - giftCard.currentBalance,
      subscription: {
        tier: SUBSCRIPTION_TIERS.PRO,
        tierName: 'Pro',
        expiresAt: expiresAt.toISOString()
      },
      referralCode: newUserReferralCard.code,
      referralMessage: 'You now have your own referral code! Share it with a friend for 50% off their Pro upgrade.' });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to apply referral code');
  }
};
