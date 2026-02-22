// src/pages/api/admin/list-payouts.ts
// Admin endpoint to list and delete payouts

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { saDeleteDocument, getServiceAccountKey } from '../../../lib/firebase-service-account';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger } from '../../../lib/api-utils';

const log = createLogger('admin/list-payouts');
import { getSaQuery } from '../../../lib/admin-query';

export const prerender = false;

// GET: List all payouts
export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`list-payouts:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  try {
    const saQuery = getSaQuery(locals);
    const payouts = await saQuery('payouts', {
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
  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to list payouts');
  }
};

// DELETE: Delete a payout by ID
export const DELETE: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`list-payouts-delete:${clientId}`, RateLimiters.adminDelete);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals.runtime.env;

  const url = new URL(request.url);
  const payoutId = url.searchParams.get('id');

  if (!payoutId) {
    return ApiErrors.badRequest('Payout ID required');
  }

  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
  const serviceAccountKey = getServiceAccountKey(env);
  if (!serviceAccountKey) {
    return ApiErrors.serverError('Firebase service account not configured');
  }

  try {
    await saDeleteDocument(serviceAccountKey, projectId, 'payouts', payoutId);

    return new Response(JSON.stringify({
      success: true,
      message: `Deleted payout ${payoutId}`
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    log.error('Delete error:', error);
    return ApiErrors.serverError('Failed to delete payout');
  }
};
