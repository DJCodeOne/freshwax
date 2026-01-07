// src/pages/api/stripe/connect/user/create-account.ts
// Creates a Stripe Connect Express account for a user (for crate selling)

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getDocument, updateDocument, initFirebaseEnv } from '../../../../../lib/firebase-rest';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Stripe not configured'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  try {
    const body = await request.json();
    const { userId, returnUrl, refreshUrl } = body;

    if (!userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User ID required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Use custom return URLs if provided, otherwise defaults
    const baseUrl = getBaseUrl(request);
    const finalReturnUrl = returnUrl || `${baseUrl}/account/selling?stripe_connected=true`;
    const finalRefreshUrl = refreshUrl || `${baseUrl}/account/selling?stripe_refresh=true`;

    // Get user
    const user = await getDocument('users', userId);

    if (!user) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // Check if already has a Connect account
    if (user.stripeConnectId) {
      const account = await stripe.accounts.retrieve(user.stripeConnectId);

      if (account.charges_enabled && account.payouts_enabled) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Stripe Connect already set up',
          status: 'active'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      // Onboarding incomplete - return new link
      const accountLink = await stripe.accountLinks.create({
        account: user.stripeConnectId,
        refresh_url: finalRefreshUrl,
        return_url: finalReturnUrl,
        type: 'account_onboarding',
      });

      return new Response(JSON.stringify({
        success: true,
        onboardingUrl: accountLink.url,
        accountId: user.stripeConnectId,
        message: 'Continue your Stripe onboarding'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Create new Express account for user
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'GB',
      email: user.email || undefined,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: 'individual',
      business_profile: {
        name: user.displayName || user.name || 'Vinyl Seller',
        product_description: 'Vinyl record sales on Fresh Wax Crates',
        url: `https://freshwax.co.uk/crates`,
      },
      metadata: {
        userId: userId,
        userName: user.displayName || user.name,
        type: 'crate_seller',
        platform: 'freshwax'
      }
    });

    // Save to user document
    await updateDocument('users', userId, {
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
      refresh_url: finalRefreshUrl,
      return_url: finalReturnUrl,
      type: 'account_onboarding',
    });

    console.log('[Stripe Connect] Created account for user:', userId, 'Account:', account.id);

    return new Response(JSON.stringify({
      success: true,
      onboardingUrl: accountLink.url,
      accountId: account.id,
      message: 'Stripe Connect account created'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[Stripe Connect] User create account error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to create Stripe account'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

function getBaseUrl(request: Request): string {
  const url = new URL(request.url);
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    return 'https://freshwax.co.uk';
  }
  return `${url.protocol}//${url.host}`;
}
