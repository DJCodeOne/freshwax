// src/pages/api/giftcards/verify-session.ts
// Verifies a Stripe checkout session for gift card purchase

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { queryCollection } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { fetchWithTimeout, ApiErrors, createLogger, jsonResponse, successResponse } from '../../../lib/api-utils';

const logger = createLogger('giftcard-verify');

// Zod schema for gift card verify-session query params
const GiftCardVerifyParamsSchema = z.object({
  session_id: z.string().min(1, 'session_id required'),
});

export const prerender = false;

export const GET: APIRoute = async ({ request, url, locals }) => {
  // Rate limit: standard (60 req/min)
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`giftcard-verify:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  logger.info('[giftcard-verify] ========== VERIFY SESSION REQUEST ==========');

  try {
    const rawParams = { session_id: url.searchParams.get('session_id') || '' };
    const paramResult = GiftCardVerifyParamsSchema.safeParse(rawParams);
    if (!paramResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const sessionId = paramResult.data.session_id;

    const env = locals.runtime.env;
    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;

    if (!stripeSecretKey) {
      return ApiErrors.serverError('Stripe not configured');
    }

    // Retrieve the session from Stripe
    logger.info('[giftcard-verify] Fetching session from Stripe:', sessionId);
    const sessionResponse = await fetchWithTimeout(
      `https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
      {
        headers: {
          'Authorization': `Bearer ${stripeSecretKey}`
        }
      },
      10000
    );

    if (!sessionResponse.ok) {
      return ApiErrors.badRequest('Invalid session');
    }

    const session = await sessionResponse.json();
    logger.info('[giftcard-verify] Session payment_status:', session.payment_status);

    // Check if payment was successful
    if (session.payment_status !== 'paid') {
      return ApiErrors.badRequest('Payment not completed');
    }

    // Try to find gift card by payment intent ID
    const paymentIntentId = session.payment_intent;
    logger.info('[giftcard-verify] Looking for gift card with paymentIntentId:', paymentIntentId);

    if (paymentIntentId) {
      const existingCards = await queryCollection('giftCards', {
        filters: [{ field: 'paymentIntentId', op: 'EQUAL', value: paymentIntentId }],
        limit: 1
      });

      if (existingCards.length > 0) {
        const card = existingCards[0];
        logger.info('[giftcard-verify] Gift card found for session:', sessionId);
        // Mask email: show first 2 chars + domain only
        const email = card.recipientEmail || '';
        const maskedEmail = email.includes('@')
          ? email.substring(0, 2) + '***@' + email.split('@')[1]
          : '***';
        return successResponse({ paymentStatus: 'paid',
          giftCard: {
            amount: card.originalValue,
            recipientEmail: maskedEmail
          } });
      }
    }

    // Gift card not found yet - webhook may still be processing
    logger.info('[giftcard-verify] Gift card not found yet, webhook may be processing');
    return jsonResponse({
      success: false,
      paymentStatus: 'paid',
      error: 'Gift card not created yet'
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('[giftcard-verify] Error:', errorMessage);
    return ApiErrors.serverError('An internal error occurred');
  }
};
