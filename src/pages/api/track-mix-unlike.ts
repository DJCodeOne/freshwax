// src/pages/api/track-mix-unlike.ts
// Tracks DJ mix unlikes using atomic decrements

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { clearCache } from '../../lib/firebase-rest';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

export const POST: APIRoute = async ({ request }) => {
  try {
    const { mixId } = await request.json();

    if (!mixId) {
      return new Response(JSON.stringify({ error: 'Invalid mixId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const mixRef = db.collection('dj-mixes').doc(mixId);

    await mixRef.update({
      likes: FieldValue.increment(-1),
      last_unliked_date: new Date().toISOString()
    });

    const mixDoc = await mixRef.get();
    
    if (!mixDoc.exists) {
      return new Response(JSON.stringify({ error: 'Mix not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const mixData = mixDoc.data();
    
    const currentLikes = mixData?.likes || 0;
    if (currentLikes < 0) {
      await mixRef.update({ likes: 0 });
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