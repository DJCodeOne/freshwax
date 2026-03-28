// src/pages/api/admin/royalty-ledger.ts
// Get royalty ledger entries for admin dashboard

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { d1GetRoyaltyLedger } from '../../../lib/d1-catalog';
import { createLogger, successResponse, ApiErrors } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

const log = createLogger('royalty-ledger');

export const prerender = false;

export const GET: APIRoute = async ({ request, url, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`royalty-ledger:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  try {
    const env = locals.runtime.env;
    const db = env?.DB;

    if (!db) {
      return ApiErrors.serverError('D1 database not available');
    }

    const brandName = url.searchParams.get('brand') || undefined;
    const status = url.searchParams.get('status') || undefined;
    const limit = parseInt(url.searchParams.get('limit') || '200');
    const offset = parseInt(url.searchParams.get('offset') || '0');

    const result = await d1GetRoyaltyLedger(db, { brandName, status, limit, offset });

    return successResponse(result);
  } catch (error: unknown) {
    log.error('[royalty-ledger] Error:', error);
    return ApiErrors.serverError('Failed to fetch royalty ledger');
  }
};
