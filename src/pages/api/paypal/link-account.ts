// src/pages/api/paypal/link-account.ts
// Link a PayPal email for payouts (artists, suppliers, users)

import type { APIRoute } from 'astro';
import { getDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { saUpdateDocument } from '../../../lib/firebase-service-account';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  initFirebaseEnv({
    FIREBASE_PROJECT_ID: projectId,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  if (!clientEmail || !privateKey) {
    console.error('[PayPal] Service account not configured');
    return new Response(JSON.stringify({
      success: false,
      error: 'Service account not configured'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  // Build service account key
  const serviceAccountKey = JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'auto',
    private_key: privateKey.replace(/\\n/g, '\n'),
    client_email: clientEmail,
    client_id: '',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token'
  });

  try {
    const body = await request.json();
    const { entityType, entityId, paypalEmail, accessCode } = body;

    // Validate entity type
    if (!['artist', 'supplier', 'user'].includes(entityType)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid entity type. Must be: artist, supplier, or user'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!paypalEmail || !emailRegex.test(paypalEmail)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Valid PayPal email required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Get the entity document
    let collection: string;
    let entity: any = null;
    let docId = entityId;

    switch (entityType) {
      case 'artist':
        collection = 'artists';
        if (entityId) {
          entity = await getDocument('artists', entityId);
        }
        break;

      case 'supplier':
        collection = 'merch-suppliers';
        if (entityId) {
          entity = await getDocument('merch-suppliers', entityId);
        } else if (accessCode) {
          // Look up by access code
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
        if (entityId) {
          entity = await getDocument('users', entityId);
        }
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

    // Update with PayPal info using service account auth
    const updateData = {
      paypalEmail: paypalEmail.toLowerCase(),
      paypalLinkedAt: new Date().toISOString(),
      payoutMethod: 'paypal', // Set as preferred method
      updatedAt: new Date().toISOString()
    };

    console.log(`[PayPal] Updating ${entityType} ${docId} with:`, JSON.stringify(updateData));

    const updatedDoc = await saUpdateDocument(serviceAccountKey, projectId, collection, docId, updateData);

    console.log(`[PayPal] Updated document response:`, JSON.stringify(updatedDoc));

    return new Response(JSON.stringify({
      success: true,
      message: 'PayPal account linked successfully',
      paypalEmail: paypalEmail.toLowerCase(),
      savedData: {
        paypalEmail: updatedDoc.paypalEmail,
        payoutMethod: updatedDoc.payoutMethod
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[PayPal] Link account error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to link PayPal account'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// GET - Check PayPal link status
export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const entityType = url.searchParams.get('entityType');
  const entityId = url.searchParams.get('entityId');
  const accessCode = url.searchParams.get('accessCode');

  if (!entityType || (!entityId && !accessCode)) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Entity type and ID (or access code) required'
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    let entity: any = null;

    switch (entityType) {
      case 'artist':
        if (entityId) entity = await getDocument('artists', entityId);
        break;

      case 'supplier':
        if (entityId) {
          entity = await getDocument('merch-suppliers', entityId);
        } else if (accessCode) {
          const { queryCollection } = await import('../../../lib/firebase-rest');
          const suppliers = await queryCollection('merch-suppliers', { limit: 100 });
          entity = suppliers.find((s: any) => s.accessCode === accessCode);
        }
        break;

      case 'user':
        if (entityId) entity = await getDocument('users', entityId);
        break;
    }

    if (!entity) {
      return new Response(JSON.stringify({
        success: false,
        error: `${entityType} not found`
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({
      success: true,
      paypalEmail: entity.paypalEmail || null,
      paypalLinked: !!entity.paypalEmail,
      paypalLinkedAt: entity.paypalLinkedAt || null,
      payoutMethod: entity.payoutMethod || null,
      stripeConnected: !!entity.stripeConnectId && entity.stripeConnectStatus === 'active'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[PayPal] Get status error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to get PayPal status'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
