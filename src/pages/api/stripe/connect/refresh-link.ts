// src/pages/api/stripe/connect/refresh-link.ts
// Generates a fresh onboarding link for incomplete Stripe Connect setup

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getDocument, verifyRequestUser } from '../../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../../lib/rate-limit';
import { SITE_URL } from '../../../../lib/constants';
import { createLogger, ApiErrors } from '../../../../lib/api-utils';

const log = createLogger('[stripe-connect-refresh]');

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
    return ApiErrors.serverError('Stripe not configured');
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  try {
    // SECURITY: Verify user authentication via Firebase token
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);

    if (!verifiedUserId || authError) {
      return ApiErrors.unauthorized('Authentication required');
    }

    const artistId = verifiedUserId;

    // Get artist document
    const artist = await getDocument('artists', artistId);
    if (!artist) {
      return ApiErrors.notFound('Artist not found');
    }

    // Check if has Connect account
    if (!artist.stripeConnectId) {
      return ApiErrors.badRequest('No Stripe Connect account found. Please start fresh setup.');
    }

    // Create new onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: artist.stripeConnectId,
      refresh_url: `${getBaseUrl(request)}/artist/account?stripe_refresh=true`,
      return_url: `${getBaseUrl(request)}/artist/account?stripe_connected=true`,
      type: 'account_onboarding',
    });

    log.info('Refreshed onboarding link for artist:', artistId);

    return new Response(JSON.stringify({
      success: true,
      onboardingUrl: accountLink.url
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: unknown) {
    log.error('Refresh link error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to generate onboarding link');
  }
};

// Helper to get base URL
function getBaseUrl(request: Request): string {
  const url = new URL(request.url);
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    return SITE_URL;
  }
  return `${url.protocol}//${url.host}`;
}
