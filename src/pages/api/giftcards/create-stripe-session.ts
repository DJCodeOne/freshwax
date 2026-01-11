// src/pages/api/giftcards/create-stripe-session.ts
// Creates Stripe checkout session for gift card purchases

import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`giftcard-stripe:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const env = (locals as any)?.runtime?.env;
    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;

    if (!stripeSecretKey) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Stripe not configured'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const data = await request.json();
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

    // Validate amount
    const numAmount = parseInt(amount);
    if (!numAmount || numAmount < 5 || numAmount > 500) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid amount. Must be between £5 and £500.'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate buyer
    if (!buyerUserId || !buyerEmail) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Must be logged in to purchase'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate recipient email for gift type
    const targetEmail = recipientType === 'gift' ? recipientEmail : buyerEmail;
    if (!targetEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid recipient email address'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    console.log('[GiftCard Stripe] Creating session for:', buyerEmail, 'amount:', numAmount);

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

    console.log('[GiftCard Stripe] Creating checkout session...');

    // Create Stripe checkout session
    const stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeSecretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: bodyParams.toString()
    });

    if (!stripeResponse.ok) {
      const errorData = await stripeResponse.json();
      console.error('[GiftCard Stripe] Create session error:', errorData);
      return new Response(JSON.stringify({
        success: false,
        error: errorData.error?.message || 'Failed to create checkout session'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const session = await stripeResponse.json();
    console.log('[GiftCard Stripe] Session created:', session.id);

    return new Response(JSON.stringify({
      success: true,
      sessionId: session.id,
      checkoutUrl: session.url
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[GiftCard Stripe] Error:', errorMessage);
    return new Response(JSON.stringify({
      success: false,
      error: errorMessage
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
