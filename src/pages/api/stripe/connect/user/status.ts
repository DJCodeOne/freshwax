// src/pages/api/stripe/connect/user/status.ts
// Get Stripe Connect status for a user (crate seller)

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getDocument, updateDocument, verifyRequestUser } from '../../../../../lib/firebase-rest';
import { ApiErrors, createLogger, successResponse } from '../../../../../lib/api-utils';

const log = createLogger('stripe/connect/user/status');
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../../../lib/rate-limit';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`connect-user-status:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');

  if (!userId) {
    return ApiErrors.badRequest('User ID required');
  }

  const env = locals.runtime.env;


  // SECURITY: Verify user authentication via Firebase token
  const { userId: authUserId, error: authError } = await verifyRequestUser(request);
  if (!authUserId || authError) {
    return ApiErrors.unauthorized('Authentication required');
  }

  // SECURITY: Verify the authenticated user matches the requested userId
  if (authUserId !== userId) {
    return ApiErrors.forbidden('Forbidden');
  }

  const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    return ApiErrors.serverError('Stripe not configured');
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  try {
    const user = await getDocument('users', userId);

    if (!user) {
      return ApiErrors.notFound('User not found');
    }

    // No Connect account yet
    if (!user.stripeConnectId) {
      return successResponse({ status: 'not_started',
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false });
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

    return successResponse({ status,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      requirements: account.requirements?.currently_due || [],
      disabledReason: account.requirements?.disabled_reason || null });

  } catch (error: unknown) {
    log.error('[Stripe Connect] User status error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to get status');
  }
};
