// src/pages/api/admin/update-order.ts
// Admin endpoint to update order details (totals, items, etc.)

import type { APIRoute } from 'astro';
import { getDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { getServiceAccountToken } from '../../../lib/firebase-service-account';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { parseJsonBody } from '../../../lib/api-utils';

export const prerender = false;

// Build service account key from individual env vars
function getServiceAccountKey(env: any): string | null {
  // Try full key first
  const fullKey = env?.FIREBASE_SERVICE_ACCOUNT_KEY || import.meta.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (fullKey) return fullKey;

  // Build from components
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

  // Parse body and verify admin auth
  const body = await parseJsonBody(request);
  const authError = requireAdminAuth(request, locals, body);
  if (authError) return authError;

  try {
    const { orderId, updates } = body;

    if (!orderId) {
      return new Response(JSON.stringify({ success: false, error: 'Missing orderId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get service account token for write permission
    const serviceAccountKey = getServiceAccountKey(env);
    if (!serviceAccountKey) {
      return new Response(JSON.stringify({ success: false, error: 'Service account not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const token = await getServiceAccountToken(serviceAccountKey);

    // Get current order
    const order = await getDocument('orders', orderId);
    if (!order) {
      return new Response(JSON.stringify({ success: false, error: 'Order not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Build update object
    const updateData: any = {
      updatedAt: new Date().toISOString()
    };

    // Update totals if provided
    if (updates?.totals) {
      updateData.totals = {
        ...order.totals,
        ...updates.totals
      };
    }

    // Update status if provided
    if (updates?.status) {
      updateData.status = updates.status;
      updateData.orderStatus = updates.status;
    }

    // Update payment method if provided
    if (updates?.paymentMethod) {
      updateData.paymentMethod = updates.paymentMethod;
    }

    // Update items if provided
    if (updates?.items) {
      updateData.items = updates.items;
    }

    // Update notes if provided
    if (updates?.notes !== undefined) {
      updateData.notes = updates.notes;
    }

    // Use direct Firestore REST API with service account token
    const updateMask = Object.keys(updateData).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/orders/${orderId}?${updateMask}`;

    // Convert to Firestore format
    const toFirestoreValue = (v: any): any => {
      if (v === null) return { nullValue: null };
      if (typeof v === 'boolean') return { booleanValue: v };
      if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
      if (typeof v === 'string') return { stringValue: v };
      if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
      if (typeof v === 'object') {
        const fields: any = {};
        for (const [k, val] of Object.entries(v)) fields[k] = toFirestoreValue(val);
        return { mapValue: { fields } };
      }
      return { stringValue: String(v) };
    };

    const fields: any = {};
    for (const [k, v] of Object.entries(updateData)) fields[k] = toFirestoreValue(v);

    const response = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ fields })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Firestore update failed: ${response.status} - ${error}`);
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Order updated',
      orderId,
      updates: updateData
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[update-order] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
