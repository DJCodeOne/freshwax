// src/pages/api/track-mix-download.ts
// OPTIMIZED: Tracks DJ mix downloads in Firebase using atomic increments

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

    // Use atomic increment
    await mixRef.update({
      downloads: FieldValue.increment(1),
      last_downloaded_date: new Date().toISOString()
    });

    // Get updated document
    const mixDoc = await mixRef.get();
    
    if (!mixDoc.exists) {
      return new Response(JSON.stringify({ error: 'Mix not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const mixData = mixDoc.data();

    console.log(`[TRACK-DOWNLOAD] ✓ Mix ${mixId} download count: ${mixData?.downloads || 0}`);

    return new Response(JSON.stringify({
      success: true,
      downloads: mixData?.downloads || 0
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[TRACK-DOWNLOAD] Error tracking download:', error);
    return new Response(JSON.stringify({
      error: 'Failed to track download',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};