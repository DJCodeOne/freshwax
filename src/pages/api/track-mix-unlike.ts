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
    const currentLikes = likes;
    if (currentLikes < 0) {
      await updateDocument('dj-mixes', mixId, { likes: 0 });
    }

    log.info('[track-mix-unlike] Mix', mixId, 'likes:', Math.max(currentLikes, 0));

    // Invalidate cache for this mix
    clearCache(`doc:dj-mixes:${mixId}`);

    return new Response(JSON.stringify({
      success: true,
      likes: Math.max(currentLikes, 0)
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