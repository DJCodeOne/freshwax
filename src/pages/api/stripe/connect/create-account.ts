// src/pages/api/stripe/connect/create-account.ts
// Creates a Stripe Connect Express account for an artist and returns onboarding link

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getDocument, updateDocument, initFirebaseEnv } from '../../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../../lib/rate-limit';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`stripe-connect-create:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // Initialize Firebase
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

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
    // Get artist ID from cookies
    const partnerId = cookies.get('partnerId')?.value;
    const firebaseUid = cookies.get('firebaseUid')?.value;
    const artistId = partnerId || firebaseUid;

    if (!artistId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Authentication required'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    // Get artist document
    const artist = await getDocument('artists', artistId);
    if (!artist) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Artist not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // Check if artist is approved
    if (!artist.approved) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Artist account must be approved before connecting Stripe'
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    // Check if already has a Connect account
    if (artist.stripeConnectId) {
      // Check if onboarding is complete
      const account = await stripe.accounts.retrieve(artist.stripeConnectId);

      if (account.charges_enabled && account.payouts_enabled) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Stripe Connect already set up',
          status: 'active'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      // Onboarding incomplete - return new link
      const accountLink = await stripe.accountLinks.create({
        account: artist.stripeConnectId,
        refresh_url: `${getBaseUrl(request)}/artist/account?stripe_refresh=true`,
        return_url: `${getBaseUrl(request)}/artist/account?stripe_connected=true`,
        type: 'account_onboarding',
      });

      return new Response(JSON.stringify({
        success: true,
        onboardingUrl: accountLink.url,
        accountId: artist.stripeConnectId,
        message: 'Continue your Stripe onboarding'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
        url: `https://freshwax.co.uk/artist/${artistId}`,
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

    console.log('[Stripe Connect] Created account for artist:', artistId, 'Account:', account.id);

    return new Response(JSON.stringify({
      success: true,
      onboardingUrl: accountLink.url,
      accountId: account.id,
      message: 'Stripe Connect account created'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[Stripe Connect] Create account error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to create Stripe account'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// Helper to get base URL
function getBaseUrl(request: Request): string {
  const url = new URL(request.url);
  // In production, always use https
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    return 'https://freshwax.co.uk';
  }
  return `${url.protocol}//${url.host}`;
}
