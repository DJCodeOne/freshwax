// src/pages/api/track-mix-like.ts
// Tracks DJ mix likes using atomic increments

import type { APIRoute } from 'astro';
import { getDocument, atomicIncrement, updateDocument, clearCache } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

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
    const { mixId } = await request.json();

    if (!mixId) {
      return new Response(JSON.stringify({ error: 'Invalid mixId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Atomically increment likes field and update last_liked_date
    const { newValues } = await atomicIncrement('dj-mixes', mixId, { likes: 1 });
    const likes = newValues.likes ?? 0;

    await updateDocument('dj-mixes', mixId, {
      last_liked_date: new Date().toISOString()
    });

    log.info('[track-mix-like] Mix', mixId, 'likes:', likes);

    // Invalidate cache for this mix
    clearCache(`doc:dj-mixes:${mixId}`);

    // Sync likes to D1 if available
    if (db) {
      try {
        const d1Row = await db.prepare('SELECT data FROM dj_mixes WHERE id = ?').bind(mixId).first();
        if (d1Row && d1Row.data) {
          const data = JSON.parse(d1Row.data);
          data.likes = likes;
          data.last_liked_date = new Date().toISOString();
          await db.prepare('UPDATE dj_mixes SET data = ? WHERE id = ?')
            .bind(JSON.stringify(data), mixId)
            .run();
          log.info('[track-mix-like] D1 synced for mix', mixId);
        }
      } catch (d1Error) {
        log.error('[track-mix-like] D1 sync error (non-fatal):', d1Error);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      likes
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      }
    });

  } catch (error) {
    log.error('[track-mix-like] Error:', error);
    return new Response(JSON.stringify({
      error: 'Failed to track like'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};