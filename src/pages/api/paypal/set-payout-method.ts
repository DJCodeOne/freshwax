// src/pages/api/paypal/set-payout-method.ts
// Set preferred payout method (stripe or paypal)

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const body = await request.json();
    const { entityType, entityId, payoutMethod, accessCode } = body;

    // Validate
    if (!['artist', 'supplier', 'user'].includes(entityType)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid entity type'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (!['stripe', 'paypal'].includes(payoutMethod)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid payout method. Must be: stripe or paypal'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Get entity
    let collection: string;
    let entity: any = null;
    let docId = entityId;

    switch (entityType) {
      case 'artist':
        collection = 'artists';
        if (entityId) entity = await getDocument('artists', entityId);
        break;

      case 'supplier':
        collection = 'merch-suppliers';
        if (entityId) {
          entity = await getDocument('merch-suppliers', entityId);
        } else if (accessCode) {
          const { queryCollection } = await import('../../../lib/firebase-rest');
          const suppliers = await queryCollection('merch-suppliers', { limit: 100 });
          const found = suppliers.find((s: any) => s.accessCode === accessCode);
          if (found) {
            entity = found;
            docId = found.id;
          }
        }
        break;

      case 'user':
        collection = 'users';
        if (entityId) entity = await getDocument('users', entityId);
        break;

      default:
        collection = '';
    }

    if (!entity) {
      return new Response(JSON.stringify({
        success: false,
        error: `${entityType} not found`
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // Verify the chosen method is available
    if (payoutMethod === 'stripe') {
      if (!entity.stripeConnectId || entity.stripeConnectStatus !== 'active') {
        return new Response(JSON.stringify({
          success: false,
          error: 'Stripe Connect not set up. Please complete Stripe onboarding first.'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
    } else if (payoutMethod === 'paypal') {
      if (!entity.paypalEmail) {
        return new Response(JSON.stringify({
          success: false,
          error: 'PayPal not linked. Please link your PayPal email first.'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Update preference
    await updateDocument(collection, docId, {
      payoutMethod,
      payoutMethodUpdatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    console.log(`[Payout] Set ${entityType} ${docId} payout method to:`, payoutMethod);

    return new Response(JSON.stringify({
      success: true,
      payoutMethod,
      message: `Payout method set to ${payoutMethod === 'stripe' ? 'Stripe' : 'PayPal'}`
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[Payout] Set method error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to set payout method'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
