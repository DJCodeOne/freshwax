// src/pages/api/stripe/connect/create-account.ts
// Creates a Stripe Connect Express account for an artist and returns onboarding link

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getDocument, updateDocument, verifyRequestUser } from '../../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../../lib/rate-limit';
import { SITE_URL } from '../../../../lib/constants';
import { createLogger, ApiErrors } from '../../../../lib/api-utils';

const log = createLogger('[stripe-connect-create]');

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`stripe-connect-create:${clientId}`, RateLimiters.standard);
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

    // Check if artist is approved
    if (!artist.approved) {
      return ApiErrors.forbidden('Artist account must be approved before connecting Stripe');
    }

    // Check if already has a Connect account
    if (artist.stripeConnectId) {
      // Check if onboarding is complete
      const account = await stripe.accounts.retrieve(artist.stripeConnectId);

      if (account.charges_enabled && account.payouts_enabled) {
        return ApiErrors.badRequest('Stripe Connect already set up');
      }

      // Onboarding incomplete - return new link
      const accountLink = await stripe.accountLinks.create({
        account: artist.stripeConnectId,
        refresh_url: `${getBaseUrl(request)}/artist/account?stripe_refresh=true`,
        return_url: `${getBaseUrl(request)}/artist/account?stripe_connected=true`,
        type: 'account_onboarding',
      });

      return successResponse({ onboardingUrl: accountLink.url,
        accountId: artist.stripeConnectId,
        message: 'Continue your Stripe onboarding' });
    }

    // Create new Express account
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'GB',
      email: artist.email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: 'individual',
      business_profile: {
        name: artist.artistName || artist.name,
        product_description: 'Music sales and digital downloads on Fresh Wax',
        url: `${SITE_URL}/artist/${artistId}`,
      },
      metadata: {
        artistId: artistId,
        artistName: artist.artistName || artist.name,
        platform: 'freshwax'
      }
    });

    // Save to artist document
    await updateDocument('artists', artistId, {
      stripeConnectId: account.id,
      stripeConnectStatus: 'onboarding',
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
      stripeDetailsSubmitted: false,
      stripeLastUpdated: new Date().toISOString()
    });

    // Create onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${getBaseUrl(request)}/artist/account?stripe_refresh=true`,
      return_url: `${getBaseUrl(request)}/artist/account?stripe_connected=true`,
      type: 'account_onboarding',
    });

    log.info('Created account for artist:', artistId, 'Account:', account.id);

    return successResponse({ onboardingUrl: accountLink.url,
      accountId: account.id,
      message: 'Stripe Connect account created' });

  } catch (error: unknown) {
    log.error('Create account error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to create Stripe account');
  }
};

// Helper to get base URL
function getBaseUrl(request: Request): string {
  const url = new URL(request.url);
  // In production, always use https
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    return SITE_URL;
  }
  return `${url.protocol}//${url.host}`;
}
