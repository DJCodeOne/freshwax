// src/pages/api/stripe/connect/supplier/create-account.ts
// Creates a Stripe Connect Express account for a supplier

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getDocument, updateDocument, initFirebaseEnv } from '../../../../../lib/firebase-rest';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
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
    const body = await request.json();
    const { supplierId, accessCode } = body;

    if (!supplierId && !accessCode) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Supplier ID or access code required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Get supplier - either by ID or access code
    let supplier: any = null;
    let supplierDocId = supplierId;

    if (supplierId) {
      supplier = await getDocument('merch-suppliers', supplierId);
    } else if (accessCode) {
      // Look up by access code
      const { queryCollection } = await import('../../../../../lib/firebase-rest');
      const suppliers = await queryCollection('merch-suppliers', { limit: 100 });
      const found = suppliers.find((s: any) => s.accessCode === accessCode);
      if (found) {
        supplier = found;
        supplierDocId = found.id;
      }
    }

    if (!supplier) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Supplier not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    if (!supplier.active) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Supplier account is not active'
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    // Check if already has a Connect account
    if (supplier.stripeConnectId) {
      const account = await stripe.accounts.retrieve(supplier.stripeConnectId);

      if (account.charges_enabled && account.payouts_enabled) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Stripe Connect already set up',
          status: 'active'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      // Onboarding incomplete - return new link
      const accountLink = await stripe.accountLinks.create({
        account: supplier.stripeConnectId,
        refresh_url: `${getBaseUrl(request)}/supplier/portal?stripe_refresh=true&code=${supplier.accessCode}`,
        return_url: `${getBaseUrl(request)}/supplier/portal?stripe_connected=true&code=${supplier.accessCode}`,
        type: 'account_onboarding',
      });

      return new Response(JSON.stringify({
        success: true,
        onboardingUrl: accountLink.url,
        accountId: supplier.stripeConnectId,
        message: 'Continue your Stripe onboarding'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
        url: `https://freshwax.co.uk/merch`,
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

    console.log('[Stripe Connect] Created account for supplier:', supplierDocId, 'Account:', account.id);

    return new Response(JSON.stringify({
      success: true,
      onboardingUrl: accountLink.url,
      accountId: account.id,
      message: 'Stripe Connect account created'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[Stripe Connect] Supplier create account error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to create Stripe account'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

function getBaseUrl(request: Request): string {
  const url = new URL(request.url);
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    return 'https://freshwax.co.uk';
  }
  return `${url.protocol}//${url.host}`;
}
