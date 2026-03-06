// src/pages/api/admin/mark-royalties-paid.ts
// Marks royalty ledger entries as paid

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { d1MarkRoyaltiesPaid } from '../../../lib/d1-catalog';
import { createLogger, successResponse, errorResponse, ApiErrors, parseJsonBody } from '../../../lib/api-utils';

const log = createLogger('mark-royalties-paid');

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  try {
    const env = locals.runtime.env;
    const db = env?.DB;

    if (!db) {
      return ApiErrors.serverError('D1 database not available');
    }

    const body = await parseJsonBody(request);
    const ids = body?.ids;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return errorResponse('ids array required', 400);
    }

    // Validate all IDs are strings
    const validIds = ids.filter((id: unknown) => typeof id === 'string' && id.length > 0) as string[];

    if (validIds.length === 0) {
      return errorResponse('No valid IDs provided', 400);
    }

    const updated = await d1MarkRoyaltiesPaid(db, validIds);

    log.info('[mark-royalties-paid] Marked', updated, 'entries as paid');

    return successResponse({ updated, ids: validIds });
  } catch (error: unknown) {
    log.error('[mark-royalties-paid] Error:', error);
    return ApiErrors.serverError('Failed to mark royalties as paid');
  }
};
