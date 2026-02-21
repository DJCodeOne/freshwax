// src/pages/api/giftcards/redeem.ts
// Redeem a gift card code and add to user's credit balance

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, setDocument, queryCollection, arrayUnion, verifyRequestUser, updateDocumentConditional, atomicIncrement } from '../../../lib/firebase-rest';
import { isValidCodeFormat, isExpired, formatGBP } from '../../../lib/giftcard';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { createLogger, ApiErrors } from '../../../lib/api-utils';

const log = createLogger('[giftcards/redeem]');

// Zod schema for gift card redemption
const RedeemSchema = z.object({
  code: z.string().min(1, 'Gift card code is required').max(50),
}).passthrough();

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: destructive operation - 3 per hour (prevent brute force)
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`giftcard-redeem:${clientId}`, RateLimiters.destructive);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // Initialize Firebase for Cloudflare runtime
  const env = locals.runtime.env;


  try {
    // Verify authentication - get userId from token, not request body
    const { userId, error: authError } = await verifyRequestUser(request);
    if (!userId) {
      return ApiErrors.unauthorized(authError || 'You must be logged in to redeem a gift card');
    }

    const rawBody = await request.json();

    const parseResult = RedeemSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { code } = parseResult.data;

    const normalizedCode = code.toUpperCase().trim();

    // Validate code format
    if (!isValidCodeFormat(normalizedCode)) {
      return ApiErrors.badRequest('Invalid Gift Card Code');
    }

    // Find the gift card
    const giftCardResults = await queryCollection('giftCards', {
      filters: [{ field: 'code', op: 'EQUAL', value: normalizedCode }],
      limit: 1
    });

    if (giftCardResults.length === 0) {
      return ApiErrors.notFound('Gift card not found');
    }

    const giftCard = giftCardResults[0];
    const giftCardId = giftCard.id;

    // Check if already redeemed
    if (giftCard.redeemedBy) {
      return ApiErrors.badRequest('This gift card has already been redeemed');
    }

    // Check if active
    if (!giftCard.isActive) {
      return ApiErrors.badRequest('This gift card is no longer active');
    }

    // Check if expired
    if (isExpired(giftCard.expiresAt)) {
      return ApiErrors.badRequest('This gift card has expired');
    }

    // Check balance
    if (giftCard.currentBalance <= 0) {
      return ApiErrors.badRequest('This gift card has no remaining balance');
    }

    // Check if this is a referral code (restricted to Pro upgrade only)
    if (giftCard.restrictedTo === 'pro_upgrade') {
      return ApiErrors.badRequest('This is a referral code that can only be used for Pro subscription upgrades. Apply it during checkout when upgrading to Pro.');
    }

    const amountToCredit = giftCard.currentBalance;
    const now = new Date();
    const nowISO = now.toISOString();

    // Atomically mark gift card as redeemed using conditional update.
    // This prevents two concurrent requests from redeeming the same card.
    // Always use conditional update - if _updateTime is missing, re-fetch the document.
    try {
      let updateTime = giftCard._updateTime;
      if (!updateTime) {
        // Re-fetch to get _updateTime for safe conditional write
        const refetchedCard = await getDocument('giftCards', giftCardId);
        if (!refetchedCard || refetchedCard.redeemedBy) {
          return ApiErrors.badRequest('This gift card has already been redeemed');
        }
        updateTime = refetchedCard._updateTime;
      }

      await updateDocumentConditional('giftCards', giftCardId, {
        redeemedBy: userId,
        redeemedAt: nowISO,
        currentBalance: 0,
        isActive: false
      }, updateTime);
    } catch (redeemErr: unknown) {
      if (redeemErr instanceof Error && redeemErr.message.includes('CONFLICT')) {
        return ApiErrors.conflict('This gift card was just redeemed. Please try again.');
      }
      throw redeemErr;
    }

    // Atomically increment user credit balance (prevents race conditions)
    const creditDoc = await getDocument('userCredits', userId);
    if (!creditDoc) {
      // Create the document first if it doesn't exist
      await setDocument('userCredits', userId, {
        userId,
        balance: 0,
        lastUpdated: nowISO,
        transactions: []
      });
    }

    await atomicIncrement('userCredits', userId, { balance: amountToCredit });

    // Read back the new balance after atomic increment
    const updatedCreditDoc = await getDocument('userCredits', userId);
    const newBalance = updatedCreditDoc?.balance || amountToCredit;

    // Create transaction record
    const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const transaction = {
      id: transactionId,
      type: 'gift_card_redemption',
      amount: amountToCredit,
      description: `Redeemed gift card ${normalizedCode} - ${giftCard.description || ''}`,
      giftCardCode: normalizedCode,
      createdAt: nowISO,
      balanceAfter: newBalance
    };

    // Atomic arrayUnion prevents lost transactions under concurrent writes
    await arrayUnion('userCredits', userId, 'transactions', [transaction], {
      lastUpdated: nowISO
    });

    // Also update the customer document with the new balance for quick access
    await updateDocument('users', userId, {
      creditBalance: newBalance,
      creditUpdatedAt: nowISO
    });

    log.info('Redeemed:', normalizedCode, 'for user:', userId, 'amount:', amountToCredit);

    return new Response(JSON.stringify({
      success: true,
      message: `Successfully redeemed ${formatGBP(amountToCredit)}!`,
      amountCredited: amountToCredit,
      newBalance,
      giftCard: {
        code: normalizedCode,
        type: giftCard.type,
        description: giftCard.description
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to redeem gift card');
  }
};
