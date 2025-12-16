// src/pages/api/giftcards/apply-referral.ts
// Apply a referral code to a Pro subscription upgrade

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';
import { isValidCodeFormat, isExpired, formatGBP, REFERRAL_DISCOUNT_AMOUNT } from '../../../lib/giftcard';
import { SUBSCRIPTION_TIERS, PRO_ANNUAL_PRICE } from '../../../lib/subscription';

export const prerender = false;

// GET: Validate a referral code
export const GET: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  if (!code) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Referral code is required'
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const normalizedCode = code.toUpperCase().trim();

  if (!isValidCodeFormat(normalizedCode)) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Invalid code format'
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const giftCardResults = await queryCollection('giftCards', {
      filters: [{ field: 'code', op: 'EQUAL', value: normalizedCode }],
      limit: 1
    });

    if (giftCardResults.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Code not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    const giftCard = giftCardResults[0];

    // Check if it's a referral code
    if (giftCard.restrictedTo !== 'pro_upgrade') {
      return new Response(JSON.stringify({
        success: false,
        error: 'This is not a referral code. Please use it on the gift card redemption page instead.'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Check if already redeemed
    if (giftCard.redeemedBy) {
      return new Response(JSON.stringify({
        success: false,
        error: 'This referral code has already been used'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Check if active
    if (!giftCard.isActive) {
      return new Response(JSON.stringify({
        success: false,
        error: 'This referral code is no longer active'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Check if expired
    if (isExpired(giftCard.expiresAt)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'This referral code has expired'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Get referrer info for display
    let referrerName = 'a friend';
    if (giftCard.createdByUserId) {
      const referrerDoc = await getDocument('users', giftCard.createdByUserId);
      if (referrerDoc?.displayName) {
        referrerName = referrerDoc.displayName;
      }
    }

    return new Response(JSON.stringify({
      success: true,
      valid: true,
      discount: giftCard.currentBalance,
      discountFormatted: formatGBP(giftCard.currentBalance),
      originalPrice: PRO_ANNUAL_PRICE,
      discountedPrice: PRO_ANNUAL_PRICE - giftCard.currentBalance,
      discountedPriceFormatted: formatGBP(PRO_ANNUAL_PRICE - giftCard.currentBalance),
      referrerName,
      message: `Referral code valid! You'll pay ${formatGBP(PRO_ANNUAL_PRICE - giftCard.currentBalance)} instead of ${formatGBP(PRO_ANNUAL_PRICE)}`
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[apply-referral] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to validate referral code'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// POST: Apply referral code and activate Pro subscription
export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const { code, userId, paymentId, userName } = await request.json();

    if (!code) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Referral code is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (!userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'You must be logged in to use a referral code'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const normalizedCode = code.toUpperCase().trim();

    // Validate code format
    if (!isValidCodeFormat(normalizedCode)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid referral code format'
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
        error: 'Referral code not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    const giftCard = giftCardResults[0];
    const giftCardId = giftCard.id;

    // Validate it's a referral code
    if (giftCard.restrictedTo !== 'pro_upgrade') {
      return new Response(JSON.stringify({
        success: false,
        error: 'This is not a valid referral code'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Check if user is trying to use their own referral code
    if (giftCard.createdByUserId === userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'You cannot use your own referral code'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Standard validation checks
    if (giftCard.redeemedBy) {
      return new Response(JSON.stringify({
        success: false,
        error: 'This referral code has already been used'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (!giftCard.isActive) {
      return new Response(JSON.stringify({
        success: false,
        error: 'This referral code is no longer active'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (isExpired(giftCard.expiresAt)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'This referral code has expired'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Check if user already has Pro
    const userDoc = await getDocument('users', userId) || {};
    if (userDoc.subscription?.tier === SUBSCRIPTION_TIERS.PRO) {
      const expiresAt = userDoc.subscription.expiresAt;
      if (!expiresAt || new Date(expiresAt) > new Date()) {
        return new Response(JSON.stringify({
          success: false,
          error: 'You already have an active Pro subscription'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
    }

    const now = new Date();
    const nowISO = now.toISOString();
    const expiresAt = new Date(now);
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);

    // Mark the referral code as redeemed
    await updateDocument('giftCards', giftCardId, {
      redeemedBy: userId,
      redeemedAt: nowISO,
      currentBalance: 0,
      isActive: false
    });

    // Import the createReferralGiftCard to give the new Pro user their own referral code
    const { createReferralGiftCard } = await import('../../../lib/giftcard');
    const newUserReferralCard = createReferralGiftCard(userId, userName || userDoc.displayName);

    // Save the new referral gift card
    const newReferralCardId = `ref_${userId}_${Date.now()}`;
    await setDocument('giftCards', newReferralCardId, {
      ...newUserReferralCard,
      id: newReferralCardId
    });

    // Activate Pro subscription
    await setDocument('users', userId, {
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
    console.log('[apply-referral] Referral code used:', normalizedCode, 'by user:', userId, 'referrer:', giftCard.createdByUserId);

    return new Response(JSON.stringify({
      success: true,
      message: 'Pro subscription activated with referral discount!',
      discount: giftCard.currentBalance,
      pricePaid: PRO_ANNUAL_PRICE - giftCard.currentBalance,
      subscription: {
        tier: SUBSCRIPTION_TIERS.PRO,
        tierName: 'Pro',
        expiresAt: expiresAt.toISOString()
      },
      referralCode: newUserReferralCard.code,
      referralMessage: 'You now have your own referral code! Share it with a friend for 50% off their Pro upgrade.'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[apply-referral] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to apply referral code'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
