// src/pages/api/dj/support.ts
// DJ support tracking — POST to add/remove manual support, GET supporters for a release
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { addDjSupport, removeDjSupport, getSupportersForRelease, getSupportsForMix } from '../../../lib/dj-support';
import { logActivity } from '../../../lib/activity-feed';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { escapeHtml } from '../../../lib/escape-html';

export const prerender = false;

const log = createLogger('api-dj-support');

const SupportSchema = z.object({
  action: z.enum(['add', 'remove']),
  mixId: z.string().min(1).max(200),
  releaseId: z.string().min(1).max(200),
  releaseTitle: z.string().max(500).optional(),
  artistName: z.string().max(200).optional(),
});

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`dj-support-read:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;
  const db = env?.DB;
  if (!db) {
    return ApiErrors.serverError('Database not available');
  }

  try {
    const url = new URL(request.url);
    const releaseId = url.searchParams.get('releaseId');
    const mixId = url.searchParams.get('mixId');

    if (releaseId) {
      const supporters = await getSupportersForRelease(db, releaseId);
      return successResponse({ supporters }, 200, {
        headers: { 'Cache-Control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=120' }
      });
    }

    if (mixId) {
      const supports = await getSupportsForMix(db, mixId);
      return successResponse({ supports }, 200, {
        headers: { 'Cache-Control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=120' }
      });
    }

    return ApiErrors.badRequest('releaseId or mixId query parameter required');
  } catch (error: unknown) {
    log.error('GET error:', error instanceof Error ? error.message : error);
    return ApiErrors.serverError('Failed to fetch support data');
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`dj-support-write:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;
  const db = env?.DB;
  if (!db) {
    return ApiErrors.serverError('Database not available');
  }

  try {
    // Auth required for manual support
    const { verifyRequestUser, getDocument } = await import('../../../lib/firebase-rest');
    const { userId, error: authError } = await verifyRequestUser(request);
    if (authError || !userId) {
      return ApiErrors.unauthorized('Authentication required');
    }

    const rawBody = await request.json();
    const parsed = SupportSchema.safeParse(rawBody);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { action, mixId, releaseId, releaseTitle, artistName } = parsed.data;

    // Get DJ name from user profile (don't trust body)
    let djName = 'Unknown DJ';
    try {
      const userDoc = await getDocument('users', userId);
      djName = userDoc?.displayName || userDoc?.name || 'Unknown DJ';
    } catch (err: unknown) {
      log.error('Failed to fetch user:', err instanceof Error ? err.message : err);
    }

    if (action === 'add') {
      if (!releaseTitle || !artistName) {
        return ApiErrors.badRequest('releaseTitle and artistName required for add action');
      }

      const inserted = await addDjSupport(db, {
        mixId,
        releaseId,
        djUserId: userId,
        djName,
        releaseTitle,
        artistName,
        source: 'manual',
        confidence: 1.0,
      });

      if (inserted) {
        // Log to activity feed (non-blocking)
        await logActivity(db, {
          eventType: 'dj_support',
          actorId: userId,
          actorName: djName,
          targetId: releaseId,
          targetType: 'release',
          targetName: releaseTitle,
          targetUrl: `/item/${escapeHtml(releaseId)}/`,
          metadata: { mixId, artistName },
        }).catch(() => { /* activity logging non-critical */ });
      }

      return successResponse({ added: inserted }, 200, {
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
      });
    }

    if (action === 'remove') {
      const removed = await removeDjSupport(db, mixId, releaseId);
      return successResponse({ removed }, 200, {
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
      });
    }

    return ApiErrors.badRequest('Invalid action');
  } catch (error: unknown) {
    log.error('POST error:', error instanceof Error ? error.message : error);
    return ApiErrors.serverError('Failed to update support');
  }
};
