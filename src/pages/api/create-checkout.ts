// src/pages/api/create-checkout.ts
// Creates Stripe checkout session for Plus subscription upgrade
// Supports unique referral codes from KV (new) and Firebase giftCards (legacy)
import type { APIRoute } from 'astro';
import { queryCollection, initFirebaseEnv } from '../../lib/firebase-rest';
import { validateReferralCode } from '../../lib/referral-codes';

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
    const { type, priceId, userId, email, promoCode, successUrl, cancelUrl } = body;

    // Validate required fields
    if (!userId || !email) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required fields'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Get Stripe key from environment
    const env = (locals as any)?.runtime?.env;
    const kv = env?.CACHE as KVNamespace | undefined;
    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;

    if (!stripeSecretKey) {
      console.log('[create-checkout] Stripe not configured - Plus upgrades not available');
      return new Response(JSON.stringify({
        success: false,
        error: 'Plus upgrades are coming soon! Payment system is being configured.'
      }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate referral code if provided
    let validatedPromoCode: string | null = null;
    let referralCardId: string | null = null;
    let referredBy: string | null = null;
    let isKvCode = false;

    if (promoCode && priceId === 'plus_annual_promo') {
      const normalizedCode = promoCode.toUpperCase().trim();

      // Try KV storage first (new referral code system)
      if (kv) {
        const kvResult = await validateReferralCode(kv, normalizedCode, userId, 'pro_upgrade');
        if (kvResult.valid && kvResult.referralCode) {
          validatedPromoCode = normalizedCode;
          referredBy = kvResult.referralCode.creatorId;
          isKvCode = true;
          console.log(`[create-checkout] Valid KV referral code ${normalizedCode} for user ${userId}, referred by ${referredBy}`);
        } else if (kvResult.error && kvResult.error !== 'Invalid referral code') {
          // KV code exists but has an error
          return new Response(JSON.stringify({
            success: false,
            error: kvResult.error
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
      }

      // Fall back to Firebase giftCards if not found in KV
      if (!validatedPromoCode) {
        initFirebase(locals);

        const giftCards = await queryCollection('giftCards', {
          filters: [
            { field: 'code', op: 'EQUAL', value: normalizedCode },
            { field: 'type', op: 'EQUAL', value: 'referral' }
          ],
          limit: 1
        });

        if (!giftCards || giftCards.length === 0) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Invalid referral code'
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }

        const referralCard = giftCards[0];

        if (!referralCard.isActive || referralCard.redeemedBy) {
          return new Response(JSON.stringify({
            success: false,
            error: 'This referral code has already been used'
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }

        if (referralCard.createdByUserId === userId) {
          return new Response(JSON.stringify({
            success: false,
            error: 'You cannot use your own referral code'
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }

        validatedPromoCode = normalizedCode;
        referralCardId = referralCard.id;
        referredBy = referralCard.createdByUserId;
        console.log(`[create-checkout] Valid Firebase referral code ${normalizedCode} for user ${userId}, referred by ${referredBy}`);
      }
    }

    // Map price IDs to actual Stripe price IDs
    const PRICE_MAP: Record<string, string> = {
      'plus_annual': env?.STRIPE_PLUS_ANNUAL_PRICE_ID || import.meta.env.STRIPE_PLUS_ANNUAL_PRICE_ID || '',
      'plus_annual_promo': env?.STRIPE_PLUS_ANNUAL_PROMO_PRICE_ID || import.meta.env.STRIPE_PLUS_ANNUAL_PROMO_PRICE_ID || '',
    };

    const stripePriceId = PRICE_MAP[priceId];
    if (!stripePriceId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid price selected'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Build metadata - include referral info if used
    const metadata: Record<string, string> = {
      'metadata[userId]': userId,
      'metadata[priceId]': priceId,
      'metadata[type]': 'plus_subscription',
    };
    if (validatedPromoCode) {
      metadata['metadata[promoCode]'] = validatedPromoCode;
      metadata['metadata[isKvCode]'] = isKvCode ? 'true' : 'false';
    }
    if (referralCardId) {
      metadata['metadata[referralCardId]'] = referralCardId;
    }
    if (referredBy) {
      metadata['metadata[referredBy]'] = referredBy;
    }

    // Create Stripe checkout session
    const stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeSecretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        'mode': type === 'subscription' ? 'subscription' : 'payment',
        'line_items[0][price]': stripePriceId,
        'line_items[0][quantity]': '1',
        'success_url': successUrl || `${new URL(request.url).origin}/account/dashboard?upgraded=true`,
        'cancel_url': cancelUrl || `${new URL(request.url).origin}/account/dashboard`,
        'customer_email': email,
        'client_reference_id': userId,
        ...metadata,
      }).toString()
    });

    if (!stripeResponse.ok) {
      const errorData = await stripeResponse.json();
      console.error('[create-checkout] Stripe error:', errorData);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to create checkout session'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const session = await stripeResponse.json();

    return new Response(JSON.stringify({
      success: true,
      checkoutUrl: session.url,
      sessionId: session.id
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[create-checkout] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to process checkout request'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
