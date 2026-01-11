// src/pages/api/admin/create-pending-payout.ts
// Admin endpoint to create a pending payout record

import type { APIRoute } from 'astro';
import { initFirebaseEnv } from '../../../lib/firebase-rest';
import { saSetDocument, saUpdateDocument } from '../../../lib/firebase-service-account';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { parseJsonBody } from '../../../lib/api-utils';

export const prerender = false;

// Build service account key from individual env vars
function getServiceAccountKey(env: any): string | null {
  const fullKey = env?.FIREBASE_SERVICE_ACCOUNT_KEY || import.meta.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (fullKey) return fullKey;

  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) return null;

  return JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'auto',
    private_key: privateKey.replace(/\\n/g, '\n'),
    client_email: clientEmail,
    client_id: '',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token'
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
  const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

  initFirebaseEnv({ FIREBASE_PROJECT_ID: projectId, FIREBASE_API_KEY: apiKey });
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });

  const body = await parseJsonBody(request);
  const authError = requireAdminAuth(request, locals, body);
  if (authError) return authError;

  try {
    const { payoutData, updateArtistBalance } = body;

    if (!payoutData) {
      return new Response(JSON.stringify({ success: false, error: 'payoutData required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const serviceAccountKey = getServiceAccountKey(env);
    if (!serviceAccountKey) {
      return new Response(JSON.stringify({ success: false, error: 'Service account not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const now = new Date().toISOString();
    const pendingPayout = {
      artistId: payoutData.artistId,
      artistName: payoutData.artistName,
      artistEmail: payoutData.artistEmail,
      orderId: payoutData.orderId,
      orderNumber: payoutData.orderNumber,
      amount: payoutData.amount,
      itemAmount: payoutData.itemAmount || payoutData.amount,
      currency: payoutData.currency || 'gbp',
      status: 'pending',
      payoutMethod: null,
      notes: payoutData.notes || '',
      createdAt: now,
      updatedAt: now
    };

    // Create pending payout with generated ID
    const payoutId = `payout_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    await saSetDocument(serviceAccountKey, projectId, 'pendingPayouts', payoutId, pendingPayout);
    console.log('[create-pending-payout] Created:', payoutId);

    // Optionally update artist's pending balance
    if (updateArtistBalance && payoutData.artistId) {
      try {
        await saUpdateDocument(serviceAccountKey, projectId, 'artists', payoutData.artistId, {
          pendingBalance: { increment: payoutData.amount }
        });
        console.log('[create-pending-payout] Updated artist pending balance');
      } catch (e) {
        console.log('[create-pending-payout] Could not update artist balance (artist doc may not exist)');
      }
    }

    return new Response(JSON.stringify({
      success: true,
      payoutId: payoutId,
      amount: payoutData.amount,
      artistName: payoutData.artistName
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[create-pending-payout] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
