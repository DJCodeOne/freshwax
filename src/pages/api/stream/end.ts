// src/pages/api/stream/end.ts
// Admin endpoint to forcefully end a stream
import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

export const prerender = false;

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store',
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

export const POST: APIRoute = async ({ request }) => {
  try {
    const data = await request.json();
    const { streamId, djId, reason } = data;

    if (!streamId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Stream ID is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const now = new Date().toISOString();
    const streamRef = db.collection('livestreams').doc(streamId);
    const streamDoc = await streamRef.get();

    if (!streamDoc.exists) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Stream not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const streamData = streamDoc.data()!;

    // End the stream
    await streamRef.update({
      status: 'offline',
      isLive: false,
      endedAt: now,
      endReason: reason || 'admin_ended',
      updatedAt: now
    });

    // Mark all viewer sessions as ended
    try {
      const sessions = await db.collection('livestream-viewers')
        .where('streamId', '==', streamId)
        .where('isActive', '==', true)
        .get();

      const batch = db.batch();
      sessions.docs.forEach(doc => {
        batch.update(doc.ref, { isActive: false, leftAt: now });
      });
      await batch.commit();
    } catch (e) {
      // Viewers collection might not exist
      console.warn('[stream/end] Could not update viewer sessions:', e);
    }

    console.log(`[stream/end] Admin ended stream ${streamId} (DJ: ${streamData.djName || djId})`);

    return new Response(JSON.stringify({
      success: true,
      message: 'Stream ended successfully'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[stream/end] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
