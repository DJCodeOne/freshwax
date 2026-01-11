// src/pages/api/giftcards/verify-session.ts
// Verifies a Stripe checkout session for gift card purchase

import type { APIRoute } from 'astro';
import { initFirebaseEnv, queryCollection } from '../../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  console.log('[giftcard-verify] ========== VERIFY SESSION REQUEST ==========');

  try {
    const sessionId = url.searchParams.get('session_id');

    if (!sessionId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing session_id'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const env = (locals as any)?.runtime?.env;
    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;

    if (!stripeSecretKey) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Stripe not configured'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    // Retrieve the session from Stripe
    console.log('[giftcard-verify] Fetching session from Stripe:', sessionId);
    const sessionResponse = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
      {
        headers: {
          'Authorization': `Bearer ${stripeSecretKey}`
        }
      }
    );

    if (!sessionResponse.ok) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid session'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const session = await sessionResponse.json();
    console.log('[giftcard-verify] Session payment_status:', session.payment_status);

    // Check if payment was successful
    if (session.payment_status !== 'paid') {
      return new Response(JSON.stringify({
        success: false,
        error: 'Payment not completed',
        paymentStatus: session.payment_status
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Initialize Firebase to find the gift card
    initFirebaseEnv({
      FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
      FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
    });

    // Try to find gift card by payment intent ID
    const paymentIntentId = session.payment_intent;
    console.log('[giftcard-verify] Looking for gift card with paymentIntentId:', paymentIntentId);

    if (paymentIntentId) {
      const existingCards = await queryCollection('giftCards', {
        filters: [{ field: 'paymentIntentId', op: 'EQUAL', value: paymentIntentId }],
        limit: 1
      });

      if (existingCards.length > 0) {
        const card = existingCards[0];
        console.log('[giftcard-verify] Gift card found:', card.code);
        return new Response(JSON.stringify({
          success: true,
          paymentStatus: 'paid',
          giftCard: {
            code: card.code,
            amount: card.originalValue,
            recipientEmail: card.recipientEmail
          }
        }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Gift card not found yet - webhook may still be processing
    console.log('[giftcard-verify] Gift card not found yet, webhook may be processing');
    return new Response(JSON.stringify({
      success: false,
      paymentStatus: 'paid',
      error: 'Gift card not created yet'
    }), { headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[giftcard-verify] Error:', errorMessage);
    return new Response(JSON.stringify({
      success: false,
      error: errorMessage
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
