// src/pages/api/stripe/connect/user/create-account.ts
// Creates a Stripe Connect Express account for a user (for crate selling)

import type { APIRoute } from 'astro';
import { z } from 'zod';
import Stripe from 'stripe';
import { getDocument, updateDocument, verifyRequestUser } from '../../../../../lib/firebase-rest';
import { SITE_URL } from '../../../../../lib/constants';
import { createLogger, ApiErrors, successResponse } from '../../../../../lib/api-utils';

const UserCreateAccountSchema = z.object({
  returnUrl: z.string().optional(),
  refreshUrl: z.string().optional(),
}).strip();

const log = createLogger('[stripe-connect-user]');
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../../../lib/rate-limit';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`connect-user-create:${clientId}`, RateLimiters.strict);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;


  const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    return ApiErrors.serverError('Stripe not configured');
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  // SECURITY: Verify user authentication via Firebase token
  const { userId: authUserId, error: authError } = await verifyRequestUser(request);
  if (!authUserId || authError) {
    return ApiErrors.unauthorized('Authentication required');
  }

  try {
    const rawBody = await request.json();
    const parseResult = UserCreateAccountSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request data');
    }
    const { returnUrl, refreshUrl } = parseResult.data;

    // Use authenticated user ID instead of trusting body
    const userId = authUserId;

    // Use custom return URLs if provided, otherwise defaults
    // SECURITY: Validate return URLs to prevent open redirect
    const baseUrl = getBaseUrl(request);
    const finalReturnUrl = isAllowedReturnUrl(returnUrl, baseUrl) ? returnUrl : `${baseUrl}/account/selling?stripe_connected=true`;
    const finalRefreshUrl = isAllowedReturnUrl(refreshUrl, baseUrl) ? refreshUrl : `${baseUrl}/account/selling?stripe_refresh=true`;

    // Get user
    const user = await getDocument('users', userId);

    if (!user) {
      return ApiErrors.notFound('User not found');
    }

    // Check if already has a Connect account
    if (user.stripeConnectId) {
      const account = await stripe.accounts.retrieve(user.stripeConnectId);

      if (account.charges_enabled && account.payouts_enabled) {
        return ApiErrors.badRequest('Stripe Connect already set up');
      }

      // Onboarding incomplete - return new link
      const accountLink = await stripe.accountLinks.create({
        account: user.stripeConnectId,
        refresh_url: finalRefreshUrl,
        return_url: finalReturnUrl,
        type: 'account_onboarding',
      });

      return successResponse({ onboardingUrl: accountLink.url,
        accountId: user.stripeConnectId,
        message: 'Continue your Stripe onboarding' });
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
        url: `${SITE_URL}/crates`,
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

    log.info('Created account for user:', userId, 'Account:', account.id);

    return successResponse({ onboardingUrl: accountLink.url,
      accountId: account.id,
      message: 'Stripe Connect account created' });

  } catch (error: unknown) {
    log.error('User create account error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to create Stripe account');
  }
};

function isAllowedReturnUrl(url: string | undefined, baseUrl: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === SITE_URL || parsed.origin === baseUrl;
  } catch (e: unknown) {
    return false;
  }
}

function getBaseUrl(request: Request): string {
  const url = new URL(request.url);
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    return SITE_URL;
  }
  return `${url.protocol}//${url.host}`;
}
