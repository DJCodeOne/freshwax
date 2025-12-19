// src/pages/api/livestream/dj-twitch-key.ts
// Returns the DJ's personal Twitch stream key for the current live stream
// Called by MediaMTX batch scripts to enable multi-streaming

import type { APIRoute } from 'astro';
import { queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';

export const GET: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const url = new URL(request.url);
    const streamKey = url.searchParams.get('streamKey');

    if (!streamKey) {
      return new Response(JSON.stringify({
        success: false,
        error: 'streamKey required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
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
