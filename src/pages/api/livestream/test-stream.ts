// src/pages/api/livestream/test-stream.ts
// TEST ONLY - Set a test stream for local development testing
// Remove this file before production deployment

import type { APIRoute } from 'astro';
import { setDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const data = await request.json();
    const { action, hlsUrl, djName, title } = data;

    // Simple admin key check
    const adminKey = env?.ADMIN_KEY || import.meta.env.ADMIN_KEY;
    if (data.adminKey !== adminKey) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (action === 'start') {
      const now = new Date().toISOString();
      const slotId = `test_${Date.now()}`;

      // Create test slot
      await setDocument('livestreamSlots', slotId, {
        djId: 'test_dj',
        djName: djName || 'Test DJ',
        djAvatar: null,
        title: title || 'Test Stream',
        status: 'live',
        hlsUrl: hlsUrl,
        streamKey: 'test_stream',
        startTime: now,
        startedAt: now,
        endTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        createdAt: now,
        updatedAt: now,
      });

      // Update active stream
      await setDocument('livestreams', 'active', {
        isLive: true,
        currentSlotId: slotId,
        djId: 'test_dj',
        djName: djName || 'Test DJ',
        djAvatar: null,
        title: title || 'Test Stream',
        hlsUrl: hlsUrl,
        startedAt: now,
      });

      return new Response(JSON.stringify({ success: true, slotId }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (action === 'stop') {
      await setDocument('livestreams', 'active', {
        isLive: false,
        currentSlotId: null,
        endedAt: new Date().toISOString(),
      });

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ success: false, error: 'Unknown action' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[test-stream] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
