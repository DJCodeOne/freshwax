// src/pages/api/admin/check-d1-release.ts
// Check what's stored in D1 for a release

import type { APIRoute } from 'astro';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, jsonResponse } from '../../../lib/api-utils';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`check-d1-release:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals.runtime.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const url = new URL(request.url);
  const releaseId = url.searchParams.get('releaseId');
  const db = env?.DB;

  if (!db) {
    return ApiErrors.serverError('D1 database not available');
  }

  try {
    if (releaseId) {
      // Get specific release
      const result = await db.prepare(
        'SELECT * FROM releases_v2 WHERE id = ?'
      ).bind(releaseId).first();

      if (!result) {
        return ApiErrors.notFound('Release not found in D1');
      }

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(result.data as string);
      } catch {
        return ApiErrors.serverError('Failed to parse release data');
      }
      return jsonResponse({
        d1Row: {
          id: result.id,
          release_date: result.release_date,
          status: result.status,
          published: result.published
        },
        releaseData: {
          releaseName: data.releaseName,
          artistName: data.artistName,
          pricePerSale: data.pricePerSale,
          trackPrice: data.trackPrice,
          pricing: data.pricing,
          catalogNumber: data.catalogNumber,
          labelCode: data.labelCode
        }
      });
    } else {
      // List all releases
      const { results } = await db.prepare(
        'SELECT id, release_date, status, published FROM releases_v2 ORDER BY release_date DESC'
      ).all();

      return jsonResponse({
        count: results.length,
        releases: results
      });
    }
  } catch (error: unknown) {
    return ApiErrors.serverError('Unknown error');
  }
};
