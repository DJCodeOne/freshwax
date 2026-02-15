// src/pages/api/giftcards/verify-session.ts
// Verifies a Stripe checkout session for gift card purchase

import type { APIRoute } from 'astro';
import { queryCollection } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

export const GET: APIRoute = async ({ request, url, locals }) => {
  // Rate limit: standard (60 req/min)
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`giftcard-verify:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  console.log('[giftcard-verify] ========== VERIFY SESSION REQUEST ==========');

  try {
    const sessionId = url.searchParams.get('session_id');

    if (!sessionId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing session_id'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const env = locals.runtime.env;
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
        console.log('[giftcard-verify] Gift card found for session:', sessionId);
        // Mask email: show first 2 chars + domain only
        const email = card.recipientEmail || '';
        const maskedEmail = email.includes('@')
          ? email.substring(0, 2) + '***@' + email.split('@')[1]
          : '***';
        return new Response(JSON.stringify({
          success: true,
          paymentStatus: 'paid',
          giftCard: {
            amount: card.originalValue,
            recipientEmail: maskedEmail
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
      error: 'An internal error occurred'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
