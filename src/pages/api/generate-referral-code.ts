// src/pages/api/generate-referral-code.ts
// Generate a referral code for Plus members who don't have one
import type { APIRoute } from 'astro';
import { getDocument, setDocument, initFirebaseEnv, verifyUserToken } from '../../lib/firebase-rest';
import { createReferralGiftCard } from '../../lib/giftcard';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any)?.runtime?.env;
    initFirebaseEnv({
      FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
      FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
    });

    // Get auth token
    const authHeader = request.headers.get('Authorization');
    const idToken = authHeader?.replace('Bearer ', '') || undefined;

    const { userId } = await request.json();

    if (!userId) {
      return new Response(JSON.stringify({ success: false, error: 'Missing userId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Verify the token matches the userId
    if (idToken) {
      try {
        const tokenUserId = await verifyUserToken(idToken);
        if (tokenUserId !== userId) {
          return new Response(JSON.stringify({ success: false, error: 'User mismatch' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      } catch (e) {
        console.error('[generate-referral-code] Token verification failed:', e);
      }
    }

    // Get user document
    const userDoc = await getDocument('users', userId);
    if (!userDoc) {
      return new Response(JSON.stringify({ success: false, error: 'User not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check if already has a referral code
    if (userDoc.referralCode) {
      return new Response(JSON.stringify({
        success: true,
        code: userDoc.referralCode,
        message: 'You already have a referral code'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check if user is Plus member
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
        error: 'Only Plus members can generate referral codes'
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Generate referral code
    console.log('[generate-referral-code] Generating code for user:', userId);
    const referralGiftCard = createReferralGiftCard(userId, userDoc.displayName || 'Plus Member');
    const referralCardId = `ref_${userId}_${Date.now()}`;

    // Save the gift card (don't pass idToken - use API key auth like get-user-type.ts)
    await setDocument('giftCards', referralCardId, {
      ...referralGiftCard,
      id: referralCardId
    });

    // Update user with referral code
    await setDocument('users', userId, {
      ...userDoc,
      referralCode: referralGiftCard.code,
      referralCodeId: referralCardId
    });

    console.log('[generate-referral-code] Generated code:', referralGiftCard.code);

    return new Response(JSON.stringify({
      success: true,
      code: referralGiftCard.code,
      message: 'Referral code generated! Share it with a friend for 50% off.'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[generate-referral-code] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to generate code'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
