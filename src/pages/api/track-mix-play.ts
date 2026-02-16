// src/pages/api/track-mix-play.ts
// Tracks DJ mix plays using atomic increments

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, atomicIncrement, clearCache } from '../../lib/firebase-rest';
import { ApiErrors } from '../../lib/api-utils';

const MixIdSchema = z.object({
  mixId: z.string().min(1, 'Invalid mixId').max(200),
});

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const POST: APIRoute = async ({ request, locals }) => {
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

    log.info('[track-mix-play] Mix', mixId, 'plays:', plays);

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
          await db.prepare('UPDATE dj_mixes SET data = ? WHERE id = ?')
            .bind(JSON.stringify(data), mixId)
            .run();
          log.info('[track-mix-play] D1 synced for mix', mixId);
        }
      } catch (d1Error) {
        log.error('[track-mix-play] D1 sync error (non-fatal):', d1Error);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      plays: plays
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      }
    });

  } catch (error) {
    log.error('[track-mix-play] Error:', error);
    return ApiErrors.serverError('Failed to track play');
  }
};
