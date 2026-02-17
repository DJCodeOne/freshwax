// src/pages/api/stripe/connect/supplier/refresh-link.ts
// Generate a fresh onboarding link for a supplier

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getDocument, queryCollection } from '../../../../../lib/firebase-rest';
import { SITE_URL } from '../../../../../lib/constants';
import { ApiErrors } from '../../../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../../../lib/rate-limit';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`connect-supplier-refresh:${clientId}`, RateLimiters.standard);
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

    if (!supplierId && !accessCode) {
      return ApiErrors.badRequest('Supplier ID or access code required');
    }

    // Get supplier
    let supplier: any = null;

    if (supplierId) {
      supplier = await getDocument('merch-suppliers', supplierId);
    } else if (accessCode) {
      const suppliers = await queryCollection('merch-suppliers', { limit: 100 });
      const found = suppliers.find((s: any) => s.accessCode === accessCode);
      if (found) {
        supplier = found;
      }
    }

    if (!supplier) {
      return ApiErrors.notFound('Supplier not found');
    }

    if (!supplier.stripeConnectId) {
      return ApiErrors.badRequest('Supplier has no Connect account. Create one first.');
    }

    // Create fresh onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: supplier.stripeConnectId,
      refresh_url: `${getBaseUrl(request)}/supplier/portal?stripe_refresh=true&code=${supplier.accessCode}`,
      return_url: `${getBaseUrl(request)}/supplier/portal?stripe_connected=true&code=${supplier.accessCode}`,
      type: 'account_onboarding',
    });

    return new Response(JSON.stringify({
      success: true,
      onboardingUrl: accountLink.url
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: unknown) {
    console.error('[Stripe Connect] Supplier refresh link error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to create onboarding link');
  }
};

function getBaseUrl(request: Request): string {
  const url = new URL(request.url);
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    return SITE_URL;
  }
  return `${url.protocol}//${url.host}`;
}
