// src/pages/api/track-mix-unlike.ts
// Tracks DJ mix unlikes using atomic decrements

import type { APIRoute } from 'astro';
import { incrementField, updateDocument, clearCache, initFirebaseEnv } from '../../lib/firebase-rest';

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

    // Decrement likes field and update last_unliked_date
    const { newValue: likes } = await incrementField('dj-mixes', mixId, 'likes', -1);

    await updateDocument('dj-mixes', mixId, {
      last_unliked_date: new Date().toISOString()
    });

    // Ensure likes don't go negative
    const finalLikes = Math.max(likes, 0);
    if (likes < 0) {
      await updateDocument('dj-mixes', mixId, { likes: 0 });
    }

    log.info('[track-mix-unlike] Mix', mixId, 'likes:', finalLikes);

    // Invalidate cache for this mix
    clearCache(`doc:dj-mixes:${mixId}`);

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
      } catch (d1Error) {
        log.error('[track-mix-unlike] D1 sync error (non-fatal):', d1Error);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      likes: finalLikes
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      }
    });

  } catch (error) {
    log.error('[track-mix-unlike] Error:', error);
    return new Response(JSON.stringify({
      error: 'Failed to track unlike',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};