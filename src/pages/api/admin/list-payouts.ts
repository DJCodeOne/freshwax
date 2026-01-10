// src/pages/api/admin/list-payouts.ts
// Admin endpoint to list and delete payouts

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { saQueryCollection, saDeleteDocument } from '../../../lib/firebase-service-account';

export const prerender = false;

function getServiceAccountKey(env: any): string {
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
  const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  return JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'auto',
    private_key: privateKey?.replace(/\\n/g, '\n'),
    client_email: clientEmail,
    client_id: '',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token'
  });
}

// GET: List all payouts
export const GET: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;

  const authError = requireAdminAuth(request, locals);
  if (authError) return authError;

  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
  const serviceAccountKey = getServiceAccountKey(env);

  try {
    const payouts = await saQueryCollection(serviceAccountKey, projectId, 'payouts', {
      orderBy: { field: 'createdAt', direction: 'DESCENDING' },
      limit: 50
    });

    return new Response(JSON.stringify({
      success: true,
      count: payouts.length,
      payouts: payouts.map(p => ({
        id: p.id,
        orderId: p.orderId,
        orderNumber: p.orderNumber,
        artistName: p.artistName,
        amount: p.amount,
        payoutMethod: p.payoutMethod,
        status: p.status,
        createdAt: p.createdAt
      }))
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('[list-payouts] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Failed to list payouts'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// DELETE: Delete a payout by ID
export const DELETE: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;

  const url = new URL(request.url);
  const payoutId = url.searchParams.get('id');

  if (!payoutId) {
    return new Response(JSON.stringify({ error: 'Payout ID required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const authError = requireAdminAuth(request, locals);
  if (authError) return authError;

  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
  const serviceAccountKey = getServiceAccountKey(env);

  try {
    await saDeleteDocument(serviceAccountKey, projectId, 'payouts', payoutId);

    return new Response(JSON.stringify({
      success: true,
      message: `Deleted payout ${payoutId}`
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('[list-payouts] Delete error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Failed to delete payout'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
