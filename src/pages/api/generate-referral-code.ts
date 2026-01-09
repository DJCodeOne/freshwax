// src/pages/api/generate-referral-code.ts
// Generate a referral code for Plus members - uses KV storage (not Firebase)
import type { APIRoute } from 'astro';
import { getDocument, initFirebaseEnv, verifyUserToken } from '../../lib/firebase-rest';
import { createReferralCode, saveReferralCode, getUserReferralCode, getReferralCode } from '../../lib/referral-codes';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any)?.runtime?.env;
    const kv = env?.CACHE as KVNamespace | undefined;

    if (!kv) {
      console.error('[generate-referral-code] KV namespace not available');
      return new Response(JSON.stringify({ success: false, error: 'Storage not available' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }

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

    // Require auth token
    if (!idToken) {
      return new Response(JSON.stringify({ success: false, error: 'Authentication required' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Verify the token matches the userId
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
      return new Response(JSON.stringify({ success: false, error: 'Invalid authentication token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check if user already has a referral code in KV
    const existingCode = await getUserReferralCode(kv, userId);
    if (existingCode) {
      // Return existing code
      const existingData = await getReferralCode(kv, existingCode);
      return new Response(JSON.stringify({
        success: true,
        code: existingCode,
        message: 'You already have a referral code',
        data: existingData
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get user document to verify Plus status (read-only, doesn't count much against quota)
    const userDoc = await getDocument('users', userId);
    if (!userDoc) {
      return new Response(JSON.stringify({ success: false, error: 'User not found' }), {
        status: 404,
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
    const referralCode = createReferralCode(
      userId,
      userDoc.displayName || 'Plus Member',
      50,  // 50% discount
      'pro_upgrade'  // Only valid for Plus upgrades
    );

    // Save to KV
    await saveReferralCode(kv, referralCode);
    console.log('[generate-referral-code] Saved to KV:', referralCode.code);

    return new Response(JSON.stringify({
      success: true,
      code: referralCode.code,
      message: 'Referral code generated! Share it with a friend for 50% off Plus.',
      data: {
        discountPercent: referralCode.discountPercent,
        expiresAt: referralCode.expiresAt,
        maxUses: referralCode.maxUses
      }
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
