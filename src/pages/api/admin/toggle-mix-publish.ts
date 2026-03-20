// src/pages/api/admin/toggle-mix-publish.ts
// Toggle DJ mix publish status
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { updateDocument, invalidateMixesCache } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { parseJsonBody, ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';
import { kvDelete, CACHE_CONFIG } from '../../../lib/kv-cache';

const log = createLogger('admin/toggle-mix-publish');
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

const toggleMixPublishSchema = z.object({
  mixId: z.string().min(1),
  published: z.boolean(),
  adminKey: z.string().optional(),
});

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`toggle-mix-publish:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  // Admin authentication
  const body = await parseJsonBody(request);
  const authError = await requireAdminAuth(request, locals, body);
  if (authError) return authError;

  const env = locals.runtime.env;

  try {
    const parsed = toggleMixPublishSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { mixId, published } = parsed.data;

    await updateDocument('dj-mixes', mixId, {
      published: !!published,
      updatedAt: new Date().toISOString()
    });

    // Clear mixes cache so changes appear immediately
    invalidateMixesCache();
    await kvDelete('live-dj-mixes-v2:all', CACHE_CONFIG.DJ_MIXES).catch(() => {});

    return successResponse({ message: `Mix ${published ? 'published' : 'unpublished'} successfully` });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to update mix');
  }
};
