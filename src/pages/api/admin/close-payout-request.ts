// src/pages/api/admin/close-payout-request.ts
// Close an open payoutRequests doc once the operator has paid the partner.

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument } from '../../../lib/firebase-rest';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const closePayoutRequestSchema = z.object({
  requestId: z.string().min(1).max(200),
  adminKey: z.string().max(500).optional(),
  idToken: z.string().max(5000).optional(),
}).strip();

const log = createLogger('admin/close-payout-request');

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`close-payout-request:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  try {
    const body = await request.json();
    const env = locals.runtime.env;
    initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const parsed = closePayoutRequestSchema.safeParse(body);
    if (!parsed.success) return ApiErrors.badRequest('requestId is required');

    const { requestId } = parsed.data;
    const doc = await getDocument('payoutRequests', requestId);
    if (!doc) return ApiErrors.notFound('Payout request not found');
    if (doc.status !== 'open') {
      return successResponse({ message: 'Already closed', requestId });
    }

    const now = new Date().toISOString();
    await updateDocument('payoutRequests', requestId, {
      status: 'closed',
      closedAt: now,
      updatedAt: now,
    });

    return successResponse({ message: 'Payout request closed', requestId, artistName: doc.artistName });
  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Unknown error');
  }
};
