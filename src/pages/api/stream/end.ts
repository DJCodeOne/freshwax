// src/pages/api/stream/end.ts
// Admin endpoint to forcefully end a stream
import type { APIRoute } from 'astro';
import { getDocument, updateDocument, queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

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
    const streamDoc = await getDocument('livestreams', streamId);

    if (!streamDoc) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Stream not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const streamData = streamDoc;

    // End the stream
    await updateDocument('livestreams', streamId, {
      status: 'offline',
      isLive: false,
      endedAt: now,
      endReason: reason || 'admin_ended',
      updatedAt: now
    });

    // Mark all viewer sessions as ended
    try {
      const sessions = await queryCollection('livestream-viewers', {
        filters: [
          { field: 'streamId', op: 'EQUAL', value: streamId },
          { field: 'isActive', op: 'EQUAL', value: true }
        ]
      });

      // Update each session individually (no batch support in REST API)
      await Promise.all(
        sessions.map(session =>
          updateDocument('livestream-viewers', session.id, {
            isActive: false,
            leftAt: now
          })
        )
      );
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
