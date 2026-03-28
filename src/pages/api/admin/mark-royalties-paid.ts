// src/pages/api/admin/mark-royalties-paid.ts
// Marks royalty ledger entries as paid

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { d1MarkRoyaltiesPaid } from '../../../lib/d1-catalog';
import { createLogger, successResponse, ApiErrors, parseJsonBody } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { z } from 'zod';

const log = createLogger('mark-royalties-paid');

const markPaidSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`mark-royalties-paid:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  try {
    const env = locals.runtime.env;
    const db = env?.DB;

    if (!db) {
      return ApiErrors.serverError('D1 database not available');
    }

    const body = await parseJsonBody(request);
    const parsed = markPaidSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('ids must be a non-empty array of strings');
    }

    const validIds = parsed.data.ids;

    const updated = await d1MarkRoyaltiesPaid(db, validIds);

    log.info('[mark-royalties-paid] Marked', updated, 'entries as paid');

    return successResponse({ updated, ids: validIds });
  } catch (error: unknown) {
    log.error('[mark-royalties-paid] Error:', error);
    return ApiErrors.serverError('Failed to mark royalties as paid');
  }
};
