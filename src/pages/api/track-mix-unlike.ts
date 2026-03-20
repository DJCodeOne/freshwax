// src/pages/api/track-mix-unlike.ts
// Tracks DJ mix unlikes using atomic decrements

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { atomicIncrement, updateDocument, clearCache, verifyRequestUser } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';
import { kvDelete, CACHE_CONFIG } from '../../lib/kv-cache';

const MixIdSchema = z.object({
  mixId: z.string().min(1, 'Invalid mixId').max(200),
});

const log = createLogger('track-mix-unlike');

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute (prevent unlike spam)
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`track-mix-unlike:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // Auth check - require logged-in user
  let userId: string | null = null;
  try {
    const result = await verifyRequestUser(request);
    if (result.userId) userId = result.userId;
  } catch (_e: unknown) {
    /* non-critical: token verification failed, will try cookie fallback */
  }
  // Also try cookie fallback
  if (!userId) {
    const cookieHeader = request.headers.get('cookie') || '';
    const match = cookieHeader.match(/(?:^|;\s*)customerId=([^;]+)/);
    if (match?.[1]) userId = match[1];
  }
  if (!userId) {
    return ApiErrors.unauthorized('Authentication required');
  }

  const env = locals.runtime.env;
  const db = env?.DB; // D1 database binding

  try {
    const body = await request.json();
    const parsed = MixIdSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { mixId } = parsed.data;

    // Atomically decrement likes field and update last_unliked_date
    const { newValues } = await atomicIncrement('dj-mixes', mixId, { likes: -1 });
    const likes = newValues.likes ?? 0;

    await updateDocument('dj-mixes', mixId, {
      last_unliked_date: new Date().toISOString()
    });

    // Ensure likes don't go negative
    const finalLikes = Math.max(likes, 0);
    if (likes < 0) {
      await updateDocument('dj-mixes', mixId, { likes: 0 });
    }

    log.info('[track-mix-unlike] Mix', mixId, 'likes:', finalLikes);

    // Invalidate caches for this mix and the listing
    clearCache(`doc:dj-mixes:${mixId}`);
    clearCache('live-mixes:50');
    clearCache('live-mixes:all');

    // Invalidate KV cache for dj-mixes
    await kvDelete('live-dj-mixes-v2:all', CACHE_CONFIG.DJ_MIXES).catch(() => {});

    // Sync likes to D1 if available
    if (db) {
      try {
        const d1Row = await db.prepare('SELECT data FROM dj_mixes WHERE id = ?').bind(mixId).first();
        if (d1Row && d1Row.data) {
          const data = JSON.parse(d1Row.data);
          data.likes = finalLikes;
          await db.prepare('UPDATE dj_mixes SET data = ? WHERE id = ?')
            .bind(JSON.stringify(data), mixId)
            .run();
          log.info('[track-mix-unlike] D1 synced for mix', mixId);
        }
      } catch (d1Error: unknown) {
        log.error('[track-mix-unlike] D1 sync error (non-fatal):', d1Error);
      }
    }

    return successResponse({ likes: finalLikes }, 200, { headers: { 'Cache-Control': 'no-cache' } });

  } catch (error: unknown) {
    log.error('[track-mix-unlike] Error:', error);
    return ApiErrors.serverError('Failed to track unlike');
  }
};