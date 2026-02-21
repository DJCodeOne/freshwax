// src/pages/api/admin/delete-orders.ts
// Admin endpoint to delete orders - requires admin key
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { deleteDocument } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { createLogger, ApiErrors } from '../../../lib/api-utils';

const log = createLogger('[delete-orders]');

const deleteOrdersSchema = z.object({
  orderIds: z.array(z.string().min(1)).min(1).max(50),
}).passthrough();

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`delete-orders:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals.runtime.env;

  // Parse body first for admin key check
  let body: any;
  try {
    body = await request.json();
  } catch {
    return ApiErrors.badRequest('Invalid JSON body');
  }

  // Check admin auth (supports Authorization header, X-Admin-Key header, or adminKey in body)
  const authError = await requireAdminAuth(request, locals, body);
  if (authError) return authError;

  try {
    const parsed = deleteOrdersSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { orderIds } = parsed.data;

    const results: { id: string; success: boolean; error?: string }[] = [];

    for (const orderId of orderIds) {
      try {
        await deleteDocument('orders', orderId);
        results.push({ id: orderId, success: true });
        log.info(`Deleted order: ${orderId}`);
      } catch (error: unknown) {
        results.push({ id: orderId, success: false, error: 'Internal error' });
        log.error(`Failed to delete ${orderId}:`, error instanceof Error ? error.message : String(error));
      }
    }

    const deleted = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    return new Response(JSON.stringify({
      success: true,
      deleted,
      failed,
      results
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Internal error');
  }
};
