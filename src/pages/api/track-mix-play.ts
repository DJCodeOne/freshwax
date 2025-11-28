// src/pages/api/track-mix-play.ts
// OPTIMIZED: Tracks DJ mix plays in Firebase using atomic increments

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// Initialize Firebase Admin
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

    // Use atomic increment to update play count
    // This is much more efficient than read-modify-write
    await mixRef.update({
      plays: FieldValue.increment(1),
      last_played_date: new Date().toISOString()
    });

    // Get the updated document to return new count
    const mixDoc = await mixRef.get();
    
    if (!mixDoc.exists) {
      return new Response(JSON.stringify({ error: 'Mix not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const mixData = mixDoc.data();

    console.log(`[TRACK-PLAY] ✓ Mix ${mixId} play count: ${mixData?.plays || 0}`);

    return new Response(JSON.stringify({
      success: true,
      plays: mixData?.plays || 0
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[TRACK-PLAY] Error tracking play:', error);
    return new Response(JSON.stringify({
      error: 'Failed to track play',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};