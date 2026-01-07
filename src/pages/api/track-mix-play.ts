// src/pages/api/track-mix-play.ts
// Tracks DJ mix plays using atomic increments

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, incrementField, clearCache, initFirebaseEnv } from '../../lib/firebase-rest';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  const db = env?.DB; // D1 database binding

  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const { mixId } = await request.json();

    if (!mixId) {
      return new Response(JSON.stringify({ error: 'Invalid mixId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check if mix exists first
    const mixDoc = await getDocument('dj-mixes', mixId);

    if (!mixDoc) {
      return new Response(JSON.stringify({ error: 'Mix not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Increment plays and update last played date
    const result = await incrementField('dj-mixes', mixId, 'plays', 1);
    await updateDocument('dj-mixes', mixId, {
      last_played_date: new Date().toISOString()
    });

    log.info('[track-mix-play] Mix', mixId, 'plays:', result.newValue);

    // Invalidate cache for this mix
    clearCache(`doc:dj-mixes:${mixId}`);

    // Sync plays to D1 if available
    if (db) {
      try {
        // Get current D1 data and update plays count
        const d1Row = await db.prepare('SELECT data FROM dj_mixes WHERE id = ?').bind(mixId).first();
        if (d1Row && d1Row.data) {
          const data = JSON.parse(d1Row.data);
          data.plays = result.newValue;
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
      plays: result.newValue
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      }
    });

  } catch (error) {
    log.error('[track-mix-play] Error:', error);
    return new Response(JSON.stringify({
      error: 'Failed to track play',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
