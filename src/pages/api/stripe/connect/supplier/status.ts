// src/pages/api/stripe/connect/supplier/status.ts
// Get Stripe Connect status for a supplier

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getDocument, queryCollection, updateDocument, initFirebaseEnv } from '../../../../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const supplierId = url.searchParams.get('supplierId');
  const accessCode = url.searchParams.get('code');

  if (!supplierId && !accessCode) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Supplier ID or access code required'
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
    // Get supplier - either by ID or access code
    let supplier: any = null;
    let supplierDocId = supplierId;

    if (supplierId) {
      supplier = await getDocument('merch-suppliers', supplierId);
    } else if (accessCode) {
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
    const updates: Record<string, any> = {};
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

  } catch (error: any) {
    console.error('[Stripe Connect] Supplier status error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to get status'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
