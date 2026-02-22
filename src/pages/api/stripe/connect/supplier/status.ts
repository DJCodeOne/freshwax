// src/pages/api/stripe/connect/supplier/status.ts
// Get Stripe Connect status for a supplier

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getDocument, queryCollection, updateDocument } from '../../../../../lib/firebase-rest';
import { ApiErrors, createLogger } from '../../../../../lib/api-utils';

const log = createLogger('stripe/connect/supplier/status');
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../../../lib/rate-limit';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`connect-supplier-status:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const url = new URL(request.url);
  const supplierId = url.searchParams.get('supplierId');
  const accessCode = url.searchParams.get('code');

  if (!supplierId && !accessCode) {
    return ApiErrors.badRequest('Supplier ID or access code required');
  }

  const env = locals.runtime.env;


  const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    return ApiErrors.serverError('Stripe not configured');
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  try {
    // Get supplier - either by ID or access code
    let supplier: Record<string, unknown> | null = null;
    let supplierDocId = supplierId;

    if (supplierId) {
      supplier = await getDocument('merch-suppliers', supplierId);
    } else if (accessCode) {
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

    // No Connect account yet
    if (!supplier.stripeConnectId) {
      return new Response(JSON.stringify({
        success: true,
        status: 'not_started',
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Get account from Stripe
    const account = await stripe.accounts.retrieve(supplier.stripeConnectId);

    // Update local cache if changed
    const updates: Record<string, unknown> = {};
    let needsUpdate = false;

    if (supplier.stripeChargesEnabled !== account.charges_enabled) {
      updates.stripeChargesEnabled = account.charges_enabled;
      needsUpdate = true;
    }
    if (supplier.stripePayoutsEnabled !== account.payouts_enabled) {
      updates.stripePayoutsEnabled = account.payouts_enabled;
      needsUpdate = true;
    }
    if (supplier.stripeDetailsSubmitted !== account.details_submitted) {
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

    if (supplier.stripeConnectStatus !== status) {
      updates.stripeConnectStatus = status;
      needsUpdate = true;
    }

    if (needsUpdate) {
      updates.stripeLastUpdated = new Date().toISOString();
      await updateDocument('merch-suppliers', supplierDocId!, updates);
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

  } catch (error: unknown) {
    log.error('[Stripe Connect] Supplier status error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to get status');
  }
};
