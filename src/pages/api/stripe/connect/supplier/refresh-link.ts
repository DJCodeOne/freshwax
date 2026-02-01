// src/pages/api/stripe/connect/supplier/refresh-link.ts
// Generate a fresh onboarding link for a supplier

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getDocument, queryCollection, initFirebaseEnv } from '../../../../../lib/firebase-rest';

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
      return new Response(JSON.stringify({
        success: false,
        error: 'Supplier not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    if (!supplier.stripeConnectId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Supplier has no Connect account. Create one first.'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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

  } catch (error: any) {
    console.error('[Stripe Connect] Supplier refresh link error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to create onboarding link'
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
