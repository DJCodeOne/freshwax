// src/pages/api/create-checkout.ts
// Creates Stripe checkout session for Plus subscription upgrade
// Supports unique referral codes from KV (new) and Firebase giftCards (legacy)
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { queryCollection, verifyRequestUser } from '../../lib/firebase-rest';
import { validateReferralCode } from '../../lib/referral-codes';
import { fetchWithTimeout, errorResponse, ApiErrors } from '../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

// Zod schema for Plus subscription checkout
const CreateCheckoutSchema = z.object({
  type: z.string().optional(),
  priceId: z.string().min(1, 'Price ID required'),
  userId: z.string().min(1, 'User ID required'),
  email: z.string().email('Valid email required'),
  promoCode: z.string().max(50).optional(),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
}).passthrough();

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`create-checkout:${clientId}`, RateLimiters.strict);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const env = locals.runtime.env;
    // Verify user authentication
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
    if (authError || !verifiedUserId) {
      return ApiErrors.unauthorized('Authentication required');
    }

    const rawBody = await request.json();

    // Zod input validation
    const parseResult = CreateCheckoutSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const body = parseResult.data;
    const { type, priceId, userId, email, promoCode, successUrl, cancelUrl } = body;

    // Verify the authenticated user matches the userId in the request
    if (verifiedUserId !== userId) {
      return ApiErrors.forbidden('You can only create checkouts for your own account');
    }
    const kv = env?.CACHE as KVNamespace | undefined;
    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;

    if (!stripeSecretKey) {
      console.log('[create-checkout] Stripe not configured - Plus upgrades not available');
      return errorResponse('Plus upgrades are coming soon! Payment system is being configured.', 503);
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
          return ApiErrors.badRequest(kvResult.error);
        }
      }

      // Fall back to Firebase giftCards if not found in KV
      if (!validatedPromoCode) {
        const giftCards = await queryCollection('giftCards', {
          filters: [
            { field: 'code', op: 'EQUAL', value: normalizedCode },
            { field: 'type', op: 'EQUAL', value: 'referral' }
          ],
          limit: 1
        });

        if (!giftCards || giftCards.length === 0) {
          return ApiErrors.badRequest('Invalid referral code');
        }

        const referralCard = giftCards[0];

        if (!referralCard.isActive || referralCard.redeemedBy) {
          return ApiErrors.badRequest('This referral code has already been used');
        }

        if (referralCard.createdByUserId === userId) {
          return ApiErrors.badRequest('You cannot use your own referral code');
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
      return ApiErrors.badRequest('Invalid price selected');
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
    const stripeResponse = await fetchWithTimeout('https://api.stripe.com/v1/checkout/sessions', {
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
    }, 10000);

    if (!stripeResponse.ok) {
      const errorData = await stripeResponse.json();
      console.error('[create-checkout] Stripe error:', errorData);
      return ApiErrors.serverError('Failed to create checkout session');
    }

    const session = await stripeResponse.json();

    return new Response(JSON.stringify({
      success: true,
      checkoutUrl: session.url,
      sessionId: session.id
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: unknown) {
    console.error('[create-checkout] Error:', error);
    return ApiErrors.serverError('Failed to process checkout request');
  }
};
