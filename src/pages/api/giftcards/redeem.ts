// src/pages/api/giftcards/redeem.ts
// Redeem a gift card code and add to user's credit balance

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, queryCollection, arrayUnion, initFirebaseEnv } from '../../../lib/firebase-rest';
import { isValidCodeFormat, isExpired, formatGBP } from '../../../lib/giftcard';

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const data = await request.json();
    const { code, userId } = data;

    if (!code) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Gift card code is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (!userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'You must be logged in to redeem a gift card'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const normalizedCode = code.toUpperCase().trim();

    // Validate code format
    if (!isValidCodeFormat(normalizedCode)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid gift card code format'
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

    const amountToCredit = giftCard.currentBalance;
    const now = new Date();
    const nowISO = now.toISOString();

    // Credit expires 1 year from redemption
    const expiryDate = new Date(now);
    expiryDate.setFullYear(expiryDate.getFullYear() + 1);
    const creditExpiresAt = expiryDate.toISOString();

    // Update gift card as redeemed
    await updateDocument('giftCards', giftCardId, {
      redeemedBy: userId,
      redeemedAt: nowISO,
      currentBalance: 0,
      isActive: false
    });

    // Get or create user credit document
    const creditDoc = await getDocument('userCredits', userId);

    let newBalance: number;
    let previousBalance: number = 0;

    if (creditDoc) {
      previousBalance = creditDoc.balance || 0;
      newBalance = previousBalance + amountToCredit;
    } else {
      newBalance = amountToCredit;
    }

    // Create transaction record with expiry
    const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const transaction = {
      id: transactionId,
      type: 'gift_card_redemption',
      amount: amountToCredit,
      description: `Redeemed gift card ${normalizedCode} - ${giftCard.description || ''}`,
      giftCardCode: normalizedCode,
      createdAt: nowISO,
      expiresAt: creditExpiresAt,
      balanceAfter: newBalance
    };

    // Update or create credit document
    if (creditDoc) {
      // Get existing transactions and add the new one
      const existingTransactions = creditDoc.transactions || [];
      await updateDocument('userCredits', userId, {
        balance: newBalance,
        lastUpdated: nowISO,
        transactions: [...existingTransactions, transaction]
      });
    } else {
      await setDocument('userCredits', userId, {
        userId,
        balance: newBalance,
        lastUpdated: nowISO,
        transactions: [transaction]
      });
    }

    // Also update the customer document with the new balance for quick access
    await updateDocument('customers', userId, {
      creditBalance: newBalance,
      creditUpdatedAt: nowISO,
      creditExpiresAt: creditExpiresAt
    });

    console.log('[giftcards/redeem] Redeemed:', normalizedCode, 'for user:', userId, 'amount:', amountToCredit, 'expires:', creditExpiresAt);

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
