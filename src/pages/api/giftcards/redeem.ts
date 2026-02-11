// src/pages/api/giftcards/redeem.ts
// Redeem a gift card code and add to user's credit balance

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, queryCollection, arrayUnion, initFirebaseEnv, verifyRequestUser, updateDocumentConditional, atomicIncrement } from '../../../lib/firebase-rest';
import { isValidCodeFormat, isExpired, formatGBP } from '../../../lib/giftcard';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: destructive operation - 3 per hour (prevent brute force)
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`giftcard-redeem:${clientId}`, RateLimiters.destructive);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    // Verify authentication - get userId from token, not request body
    const { userId, error: authError } = await verifyRequestUser(request);
    if (!userId) {
      return new Response(JSON.stringify({
        success: false,
        error: authError || 'You must be logged in to redeem a gift card'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const data = await request.json();
    const { code } = data;

    if (!code) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Gift card code is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const normalizedCode = code.toUpperCase().trim();

    // Validate code format
    if (!isValidCodeFormat(normalizedCode)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid Gift Card Code'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Find the gift card
    const giftCardResults = await queryCollection('giftCards', {
      filters: [{ field: 'code', op: 'EQUAL', value: normalizedCode }],
      limit: 1
    });

    if (giftCardResults.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Gift card not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    const giftCard = giftCardResults[0];
    const giftCardId = giftCard.id;

    // Check if already redeemed
    if (giftCard.redeemedBy) {
      return new Response(JSON.stringify({
        success: false,
        error: 'This gift card has already been redeemed'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Check if active
    if (!giftCard.isActive) {
      return new Response(JSON.stringify({
        success: false,
        error: 'This gift card is no longer active'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Check if expired
    if (isExpired(giftCard.expiresAt)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'This gift card has expired'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Check balance
    if (giftCard.currentBalance <= 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'This gift card has no remaining balance'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Check if this is a referral code (restricted to Pro upgrade only)
    if (giftCard.restrictedTo === 'pro_upgrade') {
      return new Response(JSON.stringify({
        success: false,
        error: 'This is a referral code that can only be used for Pro subscription upgrades. Apply it during checkout when upgrading to Pro.',
        isReferralCode: true,
        restrictedTo: 'pro_upgrade'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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
          return new Response(JSON.stringify({
            success: false,
            error: 'This gift card has already been redeemed'
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        updateTime = refetchedCard._updateTime;
      }

      await updateDocumentConditional('giftCards', giftCardId, {
        redeemedBy: userId,
        redeemedAt: nowISO,
        currentBalance: 0,
        isActive: false
      }, updateTime);
    } catch (redeemErr: any) {
      if (redeemErr.message?.includes('CONFLICT')) {
        return new Response(JSON.stringify({
          success: false,
          error: 'This gift card was just redeemed. Please try again.'
        }), { status: 409, headers: { 'Content-Type': 'application/json' } });
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

    // Append the transaction record
    const existingTransactions = updatedCreditDoc?.transactions || [];
    await updateDocument('userCredits', userId, {
      lastUpdated: nowISO,
      transactions: [...existingTransactions, transaction]
    });

    // Also update the customer document with the new balance for quick access
    await updateDocument('users', userId, {
      creditBalance: newBalance,
      creditUpdatedAt: nowISO
    });

    console.log('[giftcards/redeem] Redeemed:', normalizedCode, 'for user:', userId, 'amount:', amountToCredit);

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

  } catch (error) {
    console.error('[giftcards/redeem] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to redeem gift card'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
