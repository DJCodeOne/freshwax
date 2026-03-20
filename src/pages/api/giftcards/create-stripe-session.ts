// src/pages/api/giftcards/create-stripe-session.ts
// Creates Stripe checkout session for gift card purchases

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { verifyRequestUser } from '../../../lib/firebase-rest';
import { fetchWithTimeout, ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('[create-stripe-session]');

// Zod schema for gift card Stripe session creation
const GiftCardStripeSchema = z.object({
  amount: z.union([z.number(), z.string()]).refine(val => {
    const num = typeof val === 'string' ? parseInt(val) : val;
    return num >= 5 && num <= 500;
  }, 'Amount must be between 5 and 500'),
  buyerUserId: z.string().min(1, 'Buyer user ID required'),
  buyerEmail: z.string().email('Valid buyer email required'),
  buyerName: z.string().max(200).optional(),
  recipientType: z.enum(['self', 'gift']).optional(),
  recipientName: z.string().max(200).optional(),
  recipientEmail: z.string().email().optional(),
  message: z.string().max(500).optional(),
}).passthrough();

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`giftcard-stripe:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const env = locals.runtime.env;

    // SECURITY: Verify the requesting user's identity
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
    if (authError || !verifiedUserId) {
      return ApiErrors.unauthorized('Authentication required');
    }

    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;

    if (!stripeSecretKey) {
      return ApiErrors.serverError('Stripe not configured');
    }

    const rawBody = await request.json();

    const parseResult = GiftCardStripeSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const data = parseResult.data;
    const {
      amount,
      buyerUserId,
      buyerEmail,
      buyerName,
      recipientType,
      recipientName,
      recipientEmail,
      message
    } = data;

    // SECURITY: Ensure the authenticated user matches the buyer
    if (buyerUserId !== verifiedUserId) {
      return ApiErrors.forbidden('You can only purchase gift cards for your own account');
    }

    const numAmount = parseInt(String(amount));

    // Validate recipient email for gift type
    const targetEmail = recipientType === 'gift' ? recipientEmail : buyerEmail;
    if (!targetEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
      return ApiErrors.badRequest('Invalid recipient email address');
    }

    log.info('[GiftCard Stripe] Creating session for:', buyerEmail, 'amount:', numAmount);

    // Build metadata for webhook processing
    const metadata = {
      type: 'giftcard',
      amount: String(numAmount),
      buyerUserId,
      buyerEmail,
      buyerName: buyerName || '',
      recipientType: recipientType || 'self',
      recipientName: recipientName || '',
      recipientEmail: targetEmail,
      message: (message || '').substring(0, 450) // Ensure under 500 char limit
    };

    // Build request body
    const bodyParams = new URLSearchParams();
    bodyParams.append('mode', 'payment');
    bodyParams.append('payment_method_types[0]', 'card');

    // Success and cancel URLs
    const origin = new URL(request.url).origin;
    bodyParams.append('success_url', `${origin}/giftcards/success?session_id={CHECKOUT_SESSION_ID}`);
    bodyParams.append('cancel_url', `${origin}/giftcards`);

    // Single line item for the gift card
    bodyParams.append('line_items[0][price_data][currency]', 'gbp');
    bodyParams.append('line_items[0][price_data][unit_amount]', String(numAmount * 100)); // Stripe uses pence
    bodyParams.append('line_items[0][price_data][product_data][name]', `Fresh Wax Gift Card - £${numAmount}`);
    bodyParams.append('line_items[0][price_data][product_data][description]',
      recipientType === 'gift'
        ? `Gift card for ${recipientName || recipientEmail}`
        : 'Digital gift card'
    );
    bodyParams.append('line_items[0][quantity]', '1');

    // Add metadata
    Object.entries(metadata).forEach(([key, value]) => {
      bodyParams.append(`metadata[${key}]`, value);
    });

    // Customer email for receipt
    bodyParams.append('customer_email', buyerEmail);

    log.info('[GiftCard Stripe] Creating checkout session...');

    // Create Stripe checkout session
    const stripeResponse = await fetchWithTimeout('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeSecretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: bodyParams.toString()
    }, 10000);

    if (!stripeResponse.ok) {
      const errorData = await stripeResponse.json();
      log.error('[GiftCard Stripe] Create session error:', errorData);
      return ApiErrors.serverError('Failed to create checkout session');
    }

    const session = await stripeResponse.json();
    log.info('[GiftCard Stripe] Session created:', session.id);

    return successResponse({ sessionId: session.id,
      checkoutUrl: session.url });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error('[GiftCard Stripe] Error:', errorMessage);
    return ApiErrors.serverError('An internal error occurred');
  }
};
