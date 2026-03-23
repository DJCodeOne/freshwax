// src/pages/api/stripe/connect/status.ts
// Returns the current Stripe Connect account status for an artist

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getDocument, updateDocument, verifyRequestUser } from '@lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '@lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '@lib/api-utils';

const log = createLogger('stripe/connect/status');

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`stripe-connect-status:${clientId}`, RateLimiters.standard);
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
    // SECURITY: Verify user authentication via Firebase token (no cookie fallback)
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
    if (authError || !verifiedUserId) {
      return ApiErrors.unauthorized('Authentication required');
    }
    const artistId = verifiedUserId;

    // Get artist document
    const artist = await getDocument('artists', artistId);
    if (!artist) {
      return ApiErrors.notFound('Artist not found');
    }

    // If no Connect account
    if (!artist.stripeConnectId) {
      return successResponse({ connected: false,
        status: 'not_started',
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false });
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

    return successResponse({ connected: true,
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
      // Express dashboard login link (artist can manage their own account)
      // Note: Use stripe.accounts.createLoginLink() if needed, but only for active accounts
      canAccessDashboard: account.charges_enabled && account.payouts_enabled });

  } catch (error: unknown) {
    log.error('[Stripe Connect] Status error:', error);

    // Handle deleted/invalid account
    if ((error as Record<string, unknown>)?.code === 'account_invalid') {
      return successResponse({ connected: false,
        status: 'not_started',
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
        error: 'Account no longer exists' });
    }

    return ApiErrors.serverError('Failed to get account status');
  }
};
