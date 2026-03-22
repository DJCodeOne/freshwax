// src/pages/api/stripe/connect/supplier/create-account.ts
// Creates a Stripe Connect Express account for a supplier
// AUTH: Supplier access code serves as authentication — suppliers don't have Firebase
// accounts. The accessCode is a shared secret given privately to each supplier.

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getDocument, updateDocument } from '../../../../../lib/firebase-rest';
import { SITE_URL } from '../../../../../lib/constants';
import { createLogger, ApiErrors, successResponse } from '../../../../../lib/api-utils';

const log = createLogger('[stripe-connect-supplier]');
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../../../lib/rate-limit';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`connect-supplier-create:${clientId}`, RateLimiters.strict);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;


  const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    return ApiErrors.serverError('Stripe not configured');
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  try {
    const body = await request.json();
    const { supplierId, accessCode } = body;

    // SECURITY: Always require accessCode — it serves as the supplier's authentication.
    // Knowing a supplierId alone is not sufficient.
    if (!accessCode) {
      return ApiErrors.unauthorized('Access code required');
    }

    // Get supplier - either by ID + code validation, or code lookup
    let supplier: Record<string, unknown> | null = null;
    let supplierDocId = supplierId;

    if (supplierId) {
      supplier = await getDocument('merch-suppliers', supplierId);
      // Verify access code matches
      if (supplier && supplier.accessCode !== accessCode) {
        return ApiErrors.forbidden('Invalid access code');
      }
    } else {
      // Look up by access code
      const { queryCollection } = await import('../../../../../lib/firebase-rest');
      const suppliers = await queryCollection('merch-suppliers', { limit: 100 });
      const found = suppliers.find((s: Record<string, unknown>) => s.accessCode === accessCode);
      if (found) {
        supplier = found;
        supplierDocId = found.id;
      }
    }

    if (!supplier) {
      return ApiErrors.notFound('Supplier not found');
    }

    if (!supplier.active) {
      return ApiErrors.forbidden('Supplier account is not active');
    }

    // Check if already has a Connect account
    if (supplier.stripeConnectId) {
      const account = await stripe.accounts.retrieve(supplier.stripeConnectId);

      if (account.charges_enabled && account.payouts_enabled) {
        return ApiErrors.badRequest('Stripe Connect already set up');
      }

      // Onboarding incomplete - return new link
      const accountLink = await stripe.accountLinks.create({
        account: supplier.stripeConnectId,
        refresh_url: `${getBaseUrl(request)}/supplier/portal?stripe_refresh=true&code=${supplier.accessCode}`,
        return_url: `${getBaseUrl(request)}/supplier/portal?stripe_connected=true&code=${supplier.accessCode}`,
        type: 'account_onboarding',
      });

      return successResponse({ onboardingUrl: accountLink.url,
        accountId: supplier.stripeConnectId,
        message: 'Continue your Stripe onboarding' });
    }

    // Create new Express account for supplier
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'GB',
      email: supplier.email || undefined,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: supplier.type === 'individual' ? 'individual' : 'company',
      business_profile: {
        name: supplier.name,
        product_description: 'Merchandise sales on Fresh Wax',
        url: `${SITE_URL}/merch`,
      },
      metadata: {
        supplierId: supplierDocId,
        supplierName: supplier.name,
        supplierCode: supplier.code,
        type: 'supplier',
        platform: 'freshwax'
      }
    });

    // Save to supplier document
    await updateDocument('merch-suppliers', supplierDocId, {
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
      refresh_url: `${getBaseUrl(request)}/supplier/portal?stripe_refresh=true&code=${supplier.accessCode}`,
      return_url: `${getBaseUrl(request)}/supplier/portal?stripe_connected=true&code=${supplier.accessCode}`,
      type: 'account_onboarding',
    });

    log.info('Created account for supplier:', supplierDocId, 'Account:', account.id);

    return successResponse({ onboardingUrl: accountLink.url,
      accountId: account.id,
      message: 'Stripe Connect account created' });

  } catch (error: unknown) {
    log.error('Supplier create account error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to create Stripe account');
  }
};

function getBaseUrl(request: Request): string {
  const url = new URL(request.url);
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    return SITE_URL;
  }
  return `${url.protocol}//${url.host}`;
}
