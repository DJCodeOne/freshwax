// src/pages/api/stripe/connect/refresh-link.ts
// Generates a fresh onboarding link for incomplete Stripe Connect setup

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getDocument, verifyRequestUser } from '../../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../../lib/rate-limit';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`stripe-connect-refresh:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // Initialize Firebase
  const env = locals.runtime.env;


  // Get Stripe secret key
  const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Stripe not configured'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  try {
    // SECURITY: Verify user authentication via Firebase token
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);

    if (!verifiedUserId || authError) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Authentication required'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const artistId = verifiedUserId;

    // Get artist document
    const artist = await getDocument('artists', artistId);
    if (!artist) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Artist not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // Check if has Connect account
    if (!artist.stripeConnectId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'No Stripe Connect account found. Please start fresh setup.'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Create new onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: artist.stripeConnectId,
      refresh_url: `${getBaseUrl(request)}/artist/account?stripe_refresh=true`,
      return_url: `${getBaseUrl(request)}/artist/account?stripe_connected=true`,
      type: 'account_onboarding',
    });

    console.log('[Stripe Connect] Refreshed onboarding link for artist:', artistId);

    return new Response(JSON.stringify({
      success: true,
      onboardingUrl: accountLink.url
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: unknown) {
    console.error('[Stripe Connect] Refresh link error:', error instanceof Error ? error.message : String(error));
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to generate onboarding link'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// Helper to get base URL
function getBaseUrl(request: Request): string {
  const url = new URL(request.url);
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    return 'https://freshwax.co.uk';
  }
  return `${url.protocol}//${url.host}`;
}
