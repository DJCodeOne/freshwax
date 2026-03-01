// src/pages/api/track-mix-like.ts
// Tracks DJ mix likes using atomic increments

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, atomicIncrement, updateDocument, clearCache } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';
import { logActivity } from '../../lib/activity-feed';

const MixIdSchema = z.object({
  mixId: z.string().min(1, 'Invalid mixId').max(200),
});

const log = createLogger('track-mix-like');

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute (prevent like spam)
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`track-mix-like:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
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

    // Atomically increment likes field and update last_liked_date
    const { newValues } = await atomicIncrement('dj-mixes', mixId, { likes: 1 });
    const likes = newValues.likes ?? 0;

    await updateDocument('dj-mixes', mixId, {
      last_liked_date: new Date().toISOString()
    });

    log.info('[track-mix-like] Mix', mixId, 'likes:', likes);

    // Log to activity feed (non-blocking)
    if (db) {
      logActivity(db, {
        eventType: 'like',
        targetId: mixId,
        targetType: 'mix',
        metadata: { likes },
      }).catch(() => { /* activity logging non-critical */ });
    }

    // Invalidate caches for this mix and the listing
    clearCache(`doc:dj-mixes:${mixId}`);
    clearCache('live-mixes:50');
    clearCache('live-mixes:all');

    // Sync likes to D1 if available
    if (db) {
      try {
        const d1Row = await db.prepare('SELECT data FROM dj_mixes WHERE id = ?').bind(mixId).first();
        if (d1Row && d1Row.data) {
          const data = JSON.parse(d1Row.data);
          data.likes = likes;
          data.last_liked_date = new Date().toISOString();
          await db.prepare('UPDATE dj_mixes SET data = ?, likes = ?, updated_at = ? WHERE id = ?')
            .bind(JSON.stringify(data), likes, new Date().toISOString(), mixId)
            .run();
          log.info('[track-mix-like] D1 synced for mix', mixId);
        }
      } catch (d1Error: unknown) {
        log.error('[track-mix-like] D1 sync error (non-fatal):', d1Error);
      }
    }

    return successResponse({ likes }, 200, { headers: { 'Cache-Control': 'no-cache' } });

  } catch (error: unknown) {
    log.error('[track-mix-like] Error:', error);
    return ApiErrors.serverError('Failed to track like');
  }
};