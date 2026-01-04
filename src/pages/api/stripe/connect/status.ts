// src/pages/api/stripe/connect/status.ts
// Returns the current Stripe Connect account status for an artist

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getDocument, updateDocument, initFirebaseEnv } from '../../../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request, cookies, locals }) => {
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

    // If no Connect account
    if (!artist.stripeConnectId) {
      return new Response(JSON.stringify({
        success: true,
        connected: false,
        status: 'not_started',
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Retrieve account from Stripe
    const account = await stripe.accounts.retrieve(artist.stripeConnectId);

    // Determine status
    let status: string = 'onboarding';
    if (account.charges_enabled && account.payouts_enabled) {
      status = 'active';
    } else if (account.requirements?.disabled_reason) {
      status = 'restricted';
    }

    // Update local cache if status changed
    const shouldUpdate =
      artist.stripeConnectStatus !== status ||
      artist.stripeChargesEnabled !== account.charges_enabled ||
      artist.stripePayoutsEnabled !== account.payouts_enabled ||
      artist.stripeDetailsSubmitted !== account.details_submitted;

    if (shouldUpdate) {
      await updateDocument('artists', artistId, {
        stripeConnectStatus: status,
        stripeChargesEnabled: account.charges_enabled,
        stripePayoutsEnabled: account.payouts_enabled,
        stripeDetailsSubmitted: account.details_submitted,
        stripeLastUpdated: new Date().toISOString(),
        ...(status === 'active' && !artist.stripeConnectedAt ? { stripeConnectedAt: new Date().toISOString() } : {})
      });
    }

    return new Response(JSON.stringify({
      success: true,
      connected: true,
      status,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      requirements: account.requirements ? {
        currently_due: account.requirements.currently_due || [],
        eventually_due: account.requirements.eventually_due || [],
        past_due: account.requirements.past_due || [],
        disabled_reason: account.requirements.disabled_reason
      } : null,
      // Dashboard link for managing account
      dashboardUrl: account.charges_enabled ?
        `https://dashboard.stripe.com/connect/accounts/${artist.stripeConnectId}` : null
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[Stripe Connect] Status error:', error);

    // Handle deleted/invalid account
    if (error.code === 'account_invalid') {
      return new Response(JSON.stringify({
        success: true,
        connected: false,
        status: 'not_started',
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
        error: 'Account no longer exists'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to get account status'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
