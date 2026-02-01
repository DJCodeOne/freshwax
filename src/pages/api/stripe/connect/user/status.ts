// src/pages/api/stripe/connect/user/status.ts
// Get Stripe Connect status for a user (crate seller)

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getDocument, updateDocument, initFirebaseEnv } from '../../../../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');

  if (!userId) {
    return new Response(JSON.stringify({
      success: false,
      error: 'User ID required'
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

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
    const user = await getDocument('users', userId);

    if (!user) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // No Connect account yet
    if (!user.stripeConnectId) {
      return new Response(JSON.stringify({
        success: true,
        status: 'not_started',
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Get account from Stripe
    const account = await stripe.accounts.retrieve(user.stripeConnectId);

    // Update local cache if changed
    const updates: Record<string, any> = {};
    let needsUpdate = false;

    if (user.stripeChargesEnabled !== account.charges_enabled) {
      updates.stripeChargesEnabled = account.charges_enabled;
      needsUpdate = true;
    }
    if (user.stripePayoutsEnabled !== account.payouts_enabled) {
      updates.stripePayoutsEnabled = account.payouts_enabled;
      needsUpdate = true;
    }
    if (user.stripeDetailsSubmitted !== account.details_submitted) {
      updates.stripeDetailsSubmitted = account.details_submitted;
      needsUpdate = true;
    }

    // Determine status
    let status: 'onboarding' | 'active' | 'restricted' = 'onboarding';
    if (account.charges_enabled && account.payouts_enabled) {
      status = 'active';
    } else if (account.requirements?.disabled_reason) {
      status = 'restricted';
    }

    if (user.stripeConnectStatus !== status) {
      updates.stripeConnectStatus = status;
      needsUpdate = true;
    }

    if (needsUpdate) {
      updates.stripeLastUpdated = new Date().toISOString();
      await updateDocument('users', userId, updates);
    }

    return new Response(JSON.stringify({
      success: true,
      status,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      requirements: account.requirements?.currently_due || [],
      disabledReason: account.requirements?.disabled_reason || null
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[Stripe Connect] User status error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to get status'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
