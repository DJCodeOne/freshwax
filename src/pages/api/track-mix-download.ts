// src/pages/api/track-mix-download.ts
// Tracks DJ mix downloads using atomic increments

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { atomicIncrement, updateDocument, clearCache } from '../../lib/firebase-rest';
import { ApiErrors, createLogger } from '../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

const MixIdSchema = z.object({
  mixId: z.string().min(1, 'Invalid mixId').max(200),
});

const logger = createLogger('track-mix-download');

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`track-mix-download:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;
  const db = env?.DB;

  try {
    const body = await request.json();
    const parsed = MixIdSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { mixId } = parsed.data;

    // Atomically increment downloads field and update last_downloaded_date
    const { newValues } = await atomicIncrement('dj-mixes', mixId, { downloads: 1 });
    const downloads = newValues.downloads ?? 0;

    await updateDocument('dj-mixes', mixId, {
      last_downloaded_date: new Date().toISOString()
    });

    logger.info('[track-mix-download] Mix', mixId, 'downloads:', downloads);

    // Invalidate caches for this mix and the listing
    clearCache(`doc:dj-mixes:${mixId}`);
    clearCache('live-mixes:50');
    clearCache('live-mixes:all');

    // Sync downloads to D1 if available
    if (db) {
      try {
        const d1Row = await db.prepare('SELECT data FROM dj_mixes WHERE id = ?').bind(mixId).first();
        if (d1Row && d1Row.data) {
          const data = JSON.parse(d1Row.data);
          data.downloads = downloads;
          data.last_downloaded_date = new Date().toISOString();
          await db.prepare('UPDATE dj_mixes SET data = ?, downloads = ?, updated_at = ? WHERE id = ?')
            .bind(JSON.stringify(data), downloads, new Date().toISOString(), mixId)
            .run();
          logger.info('[track-mix-download] D1 synced for mix', mixId);
        }
      } catch (d1Error: unknown) {
        logger.error('[track-mix-download] D1 sync error (non-fatal):', d1Error);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      downloads
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      }
    });

  } catch (error: unknown) {
    logger.error('[track-mix-download] Error:', error);
    return ApiErrors.serverError('Failed to track download');
  }
};