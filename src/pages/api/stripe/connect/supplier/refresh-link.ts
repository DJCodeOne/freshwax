// src/pages/api/stripe/connect/supplier/refresh-link.ts
// Generate a fresh onboarding link for a supplier
// AUTH: Supplier access code serves as authentication — suppliers don't have Firebase
// accounts. The accessCode is a shared secret given privately to each supplier.

import type { APIRoute } from 'astro';
import { z } from 'zod';
import Stripe from 'stripe';
import { getDocument, queryCollection } from '../../../../../lib/firebase-rest';
import { SITE_URL } from '../../../../../lib/constants';
import { ApiErrors, createLogger, successResponse } from '../../../../../lib/api-utils';

const SupplierRefreshLinkSchema = z.object({
  supplierId: z.string().optional(),
  accessCode: z.string().min(1),
}).strip();

const log = createLogger('stripe/connect/supplier/refresh-link');
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
    const rawBody = await request.json();
    const parseResult = SupplierRefreshLinkSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request data');
    }
    const { supplierId, accessCode } = parseResult.data;

    // Get supplier
    let supplier: Record<string, unknown> | null = null;

    if (supplierId) {
      supplier = await getDocument('merch-suppliers', supplierId);
      // Verify access code matches
      if (supplier && supplier.accessCode !== accessCode) {
        return ApiErrors.forbidden('Invalid access code');
      }
    } else {
      const suppliers = await queryCollection('merch-suppliers', { limit: 100 });
      const found = suppliers.find((s: Record<string, unknown>) => s.accessCode === accessCode);
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

    return successResponse({ onboardingUrl: accountLink.url });

  } catch (error: unknown) {
    log.error('[Stripe Connect] Supplier refresh link error:', error instanceof Error ? error.message : String(error));
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
