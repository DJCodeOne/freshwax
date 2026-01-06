// src/pages/api/plus/validate-promo.ts
// Validate referral codes for Plus membership - 50% off (£5 instead of £10)
// Each referral code can only be used ONCE total (not per user)
// Referral codes are generated when users become Plus members

import type { APIRoute } from 'astro';
import { getDocument, queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY || 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g',
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const { code, userId } = body;

    if (!code || !userId) {
      return new Response(JSON.stringify({
        success: false,
        valid: false,
        error: 'Missing code or userId'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const normalizedCode = code.toUpperCase().trim();
    initFirebase(locals);

    // Check if user is already a Plus member
    const userDoc = await getDocument('users', userId);
    if (userDoc?.subscription?.tier === 'pro') {
      const expiresAt = userDoc.subscription.expiresAt;
      if (expiresAt && new Date(expiresAt) > new Date()) {
        return new Response(JSON.stringify({
          success: true,
          valid: false,
          error: 'You already have an active Plus subscription'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Look up referral code in giftCards collection
    const giftCards = await queryCollection('giftCards', {
      filters: [
        { field: 'code', op: 'EQUAL', value: normalizedCode },
        { field: 'type', op: 'EQUAL', value: 'referral' }
      ],
      limit: 1
    });

    if (!giftCards || giftCards.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        valid: false,
        error: 'Invalid referral code'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const referralCard = giftCards[0];

    // Check if code is still active (not already redeemed)
    if (!referralCard.isActive || referralCard.redeemedBy) {
      return new Response(JSON.stringify({
        success: true,
        valid: false,
        error: 'This referral code has already been used'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Check if code is expired
    if (referralCard.expiresAt && new Date(referralCard.expiresAt) < new Date()) {
      return new Response(JSON.stringify({
        success: true,
        valid: false,
        error: 'This referral code has expired'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Prevent users from using their own referral code
    if (referralCard.createdByUserId === userId) {
      return new Response(JSON.stringify({
        success: true,
        valid: false,
        error: 'You cannot use your own referral code'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Code is valid!
    return new Response(JSON.stringify({
      success: true,
      valid: true,
      discount: 50,
      message: '50% off Plus membership - Pay only £5!',
      finalPrice: 5,
      referralCardId: referralCard.id,
      referredBy: referralCard.createdByUserId
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[validate-promo] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      valid: false,
      error: 'Failed to validate code'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
