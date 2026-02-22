// src/pages/api/track-mix-play.ts
// Tracks DJ mix plays using atomic increments

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, atomicIncrement, clearCache } from '../../lib/firebase-rest';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

const MixIdSchema = z.object({
  mixId: z.string().min(1, 'Invalid mixId').max(200),
});

const logger = createLogger('track-mix-play');

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`track-mix-play:${clientId}`, RateLimiters.standard);
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

    // Check if mix exists first
    const mixDoc = await getDocument('dj-mixes', mixId);

    if (!mixDoc) {
      return ApiErrors.notFound('Mix not found');
    }

    // Atomically increment plays and update last played date
    const { newValues } = await atomicIncrement('dj-mixes', mixId, { plays: 1 });
    const plays = newValues.plays ?? 0;
    await updateDocument('dj-mixes', mixId, {
      last_played_date: new Date().toISOString()
    });

    logger.info('[track-mix-play] Mix', mixId, 'plays:', plays);

    // Invalidate caches for this mix and the listing
    clearCache(`doc:dj-mixes:${mixId}`);
    clearCache('live-mixes:50');
    clearCache('live-mixes:all');

    // Sync plays to D1 if available
    if (db) {
      try {
        // Get current D1 data and update plays count
        const d1Row = await db.prepare('SELECT data FROM dj_mixes WHERE id = ?').bind(mixId).first();
        if (d1Row && d1Row.data) {
          const data = JSON.parse(d1Row.data);
          data.plays = plays;
          data.last_played_date = new Date().toISOString();
          await db.prepare('UPDATE dj_mixes SET data = ?, plays = ?, updated_at = ? WHERE id = ?')
            .bind(JSON.stringify(data), plays, new Date().toISOString(), mixId)
            .run();
          logger.info('[track-mix-play] D1 synced for mix', mixId);
        }
      } catch (d1Error: unknown) {
        logger.error('[track-mix-play] D1 sync error (non-fatal):', d1Error);
      }
    }

    return successResponse({ plays: plays }, 200, { headers: { 'Cache-Control': 'no-cache' } });

  } catch (error: unknown) {
    logger.error('[track-mix-play] Error:', error);
    return ApiErrors.serverError('Failed to track play');
  }
};
