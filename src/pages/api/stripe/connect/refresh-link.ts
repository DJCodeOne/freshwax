// src/pages/api/stripe/connect/refresh-link.ts
// Generates a fresh onboarding link for incomplete Stripe Connect setup

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getDocument, initFirebaseEnv } from '../../../../lib/firebase-rest';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies, locals }) => {
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

  } catch (error: any) {
    console.error('[Stripe Connect] Refresh link error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to generate onboarding link'
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
