// src/pages/api/admin/update-order.ts
// Admin endpoint to update order details (totals, items, etc.)

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument } from '../../../lib/firebase-rest';
import { getServiceAccountToken, getServiceAccountKey } from '../../../lib/firebase-service-account';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { parseJsonBody, fetchWithTimeout, ApiErrors, createLogger } from '../../../lib/api-utils';

const log = createLogger('admin/update-order');
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

const updateOrderSchema = z.object({
  orderId: z.string().min(1),
  updates: z.object({
    totals: z.record(z.any()).optional(),
    status: z.string().optional(),
    paymentMethod: z.string().optional(),
    items: z.array(z.any()).optional(),
    notes: z.string().optional(),
  }).passthrough().optional(),
  adminKey: z.string().optional(),
});

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`update-order:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals.runtime.env;
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
  const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;


  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });

  // Parse body and verify admin auth
  const body = await parseJsonBody(request);
  const authError = await requireAdminAuth(request, locals, body);
  if (authError) return authError;

  try {
    const parsed = updateOrderSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { orderId, updates } = parsed.data;

    // Get service account token for write permission
    const serviceAccountKey = getServiceAccountKey(env);
    if (!serviceAccountKey) {
      return ApiErrors.serverError('Service account not configured');
    }
    const token = await getServiceAccountToken(serviceAccountKey);

    // Get current order
    const order = await getDocument('orders', orderId);
    if (!order) {
      return ApiErrors.notFound('Order not found');
    }

    // Build update object
    const updateData: Record<string, unknown> = {
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
    const toFirestoreValue = (v: unknown): Record<string, unknown> => {
      if (v === null) return { nullValue: null };
      if (typeof v === 'boolean') return { booleanValue: v };
      if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
      if (typeof v === 'string') return { stringValue: v };
      if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
      if (typeof v === 'object') {
        const fields: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) fields[k] = toFirestoreValue(val);
        return { mapValue: { fields } };
      }
      return { stringValue: String(v) };
    };

    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(updateData)) fields[k] = toFirestoreValue(v);

    const response = await fetchWithTimeout(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ fields })
    }, 10000);

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

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Unknown error');
  }
};
