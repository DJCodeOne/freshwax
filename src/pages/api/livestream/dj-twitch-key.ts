// src/pages/api/livestream/dj-twitch-key.ts
// Returns the DJ's personal Twitch stream key for the current live stream
// Called by MediaMTX batch scripts to enable multi-streaming
// SECURITY: Requires server key to prevent unauthorized access

import type { APIRoute } from 'astro';
import { queryCollection } from '../../../lib/firebase-rest';
import { ApiErrors } from '../../../lib/api-utils';

function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let result = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    result |= (a.charCodeAt(i % a.length) || 0) ^ (b.charCodeAt(i % b.length) || 0);
  }
  return result === 0;
}

export const GET: APIRoute = async ({ request, locals }) => {
  const env = locals?.runtime?.env;

  try {
    const url = new URL(request.url);
    const streamKey = url.searchParams.get('streamKey');
    // SECURITY: Only accept server key from headers - never query params (they appear in logs)
    const serverKey = request.headers.get('x-server-key');

    // SECURITY: Require server key for access to Twitch credentials (timing-safe comparison)
    const expectedServerKey = env?.STREAM_SERVER_KEY || import.meta.env.STREAM_SERVER_KEY;
    if (!expectedServerKey || !serverKey || !timingSafeEqual(serverKey, expectedServerKey)) {
      console.warn('[dj-twitch-key] Unauthorized access attempt');
      return ApiErrors.forbidden('Unauthorized');
    }

    if (!streamKey) {
      return ApiErrors.badRequest('streamKey required');
    }

    // Find the slot by stream key
    const slots = await queryCollection('livestreamSlots', {
      filters: [{ field: 'streamKey', op: 'EQUAL', value: streamKey }],
      limit: 1
    });

    if (slots.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Slot not found',
        djTwitchKey: null
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const slot = slots[0];

    return new Response(JSON.stringify({
      success: true,
      djTwitchKey: slot.twitchStreamKey || null,
      djName: slot.djName || 'Unknown DJ'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[dj-twitch-key] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Internal error',
      djTwitchKey: null
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
