// src/pages/api/create-checkout.ts
// Creates Stripe checkout session for Plus subscription upgrade
import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const { type, priceId, userId, email, successUrl, cancelUrl } = body;

    // Validate required fields
    if (!userId || !email) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required fields'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Get Stripe key from environment
    const env = (locals as any)?.runtime?.env;
    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;

    if (!stripeSecretKey) {
      console.log('[create-checkout] Stripe not configured - Plus upgrades not available');
      return new Response(JSON.stringify({
        success: false,
        error: 'Plus upgrades are coming soon! Payment system is being configured.'
      }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }

    // Map price IDs to actual Stripe price IDs
    const PRICE_MAP: Record<string, string> = {
      'plus_annual': env?.STRIPE_PLUS_ANNUAL_PRICE_ID || import.meta.env.STRIPE_PLUS_ANNUAL_PRICE_ID || '',
    };

    const stripePriceId = PRICE_MAP[priceId];
    if (!stripePriceId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid price selected'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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
        'metadata[userId]': userId,
        'metadata[priceId]': priceId,
        'metadata[type]': 'plus_subscription',
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
