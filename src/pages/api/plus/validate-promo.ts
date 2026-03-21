// src/pages/api/plus/validate-promo.ts
// Validate referral codes for Plus membership - 50% off (£5 instead of £10)
// Checks KV storage first (new system), then falls back to Firebase giftCards (legacy)

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, queryCollection } from '../../../lib/firebase-rest';
import { validateReferralCode } from '../../../lib/referral-codes';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('plus/validate-promo');

// Zod schema for promo code validation
const ValidatePromoSchema = z.object({
  code: z.string().min(1, 'Referral code is required').max(50),
  userId: z.string().min(1, 'User ID is required'),
}).strip();

export const prerender = false;



export const POST: APIRoute = async ({ request, locals }) => {
  // SECURITY: Rate limit to prevent brute-force of promo/referral codes
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`validate-promo:${clientId}`, RateLimiters.strict);
  if (!rateLimit.allowed) return rateLimitResponse(rateLimit.retryAfter!);

  try {
    const env = locals.runtime.env;
    const kv = env?.CACHE as KVNamespace | undefined;

    const body = await request.json();

    const parseResult = ValidatePromoSchema.safeParse(body);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { code, userId } = parseResult.data;

    const normalizedCode = code.toUpperCase().trim();

    // Check if user is already a Plus member
    const userDoc = await getDocument('users', userId);
    if (userDoc?.subscription?.tier === 'pro') {
      const expiresAt = userDoc.subscription.expiresAt;
      if (expiresAt && new Date(expiresAt) > new Date()) {
        return successResponse({ valid: false,
          error: 'You already have an active Plus subscription' });
      }
    }

    // Try KV storage first (new referral code system)
    if (kv) {
      const kvResult = await validateReferralCode(kv, normalizedCode, userId, 'pro_upgrade');
      if (kvResult.valid && kvResult.referralCode) {
        return successResponse({ valid: true,
          discount: kvResult.referralCode.discountPercent,
          message: `${kvResult.referralCode.discountPercent}% off Plus membership - Pay only £5!`,
          finalPrice: 5,
          isKvCode: true, // Flag to indicate KV-based code
          referredBy: kvResult.referralCode.creatorId });
      } else if (kvResult.error && kvResult.error !== 'Invalid referral code') {
        // KV code exists but has an error (expired, used, etc.)
        return successResponse({ valid: false,
          error: kvResult.error });
      }
      // If not found in KV, fall through to check Firebase
    }

    // Fall back to Firebase giftCards collection (legacy system)
    const giftCards = await queryCollection('giftCards', {
      filters: [
        { field: 'code', op: 'EQUAL', value: normalizedCode },
        { field: 'type', op: 'EQUAL', value: 'referral' }
      ],
      limit: 1
    });

    if (!giftCards || giftCards.length === 0) {
      return successResponse({ valid: false,
        error: 'Invalid referral code' });
    }

    const referralCard = giftCards[0];

    // Check if code is still active (not already redeemed)
    if (!referralCard.isActive || referralCard.redeemedBy) {
      return successResponse({ valid: false,
        error: 'This referral code has already been used' });
    }

    // Check if code is expired
    if (referralCard.expiresAt && new Date(referralCard.expiresAt) < new Date()) {
      return successResponse({ valid: false,
        error: 'This referral code has expired' });
    }

    // Prevent users from using their own referral code
    if (referralCard.createdByUserId === userId) {
      return successResponse({ valid: false,
        error: 'You cannot use your own referral code' });
    }

    // Code is valid!
    return successResponse({ valid: true,
      discount: 50,
      message: '50% off Plus membership - Pay only £5!',
      finalPrice: 5,
      referralCardId: referralCard.id,
      referredBy: referralCard.createdByUserId });

  } catch (error: unknown) {
    log.error('[validate-promo] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to validate code');
  }
};
