// src/pages/api/livestream/dj-twitch-key.ts
// Returns the DJ's personal Twitch stream key for the current live stream
// Called by MediaMTX batch scripts to enable multi-streaming
// SECURITY: Requires server key to prevent unauthorized access

import type { APIRoute } from 'astro';
import { queryCollection } from '../../../lib/firebase-rest';
import { ApiErrors, createLogger, successResponse, jsonResponse } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

const log = createLogger('livestream/dj-twitch-key');

function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let result = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    result |= (a.charCodeAt(i % a.length) || 0) ^ (b.charCodeAt(i % b.length) || 0);
  }
  return result === 0;
}

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`dj-twitch-key:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals?.runtime?.env;

  try {
    const url = new URL(request.url);
    const streamKey = url.searchParams.get('streamKey');
    // current=1 — return the currently-live DJ's Twitch key WITHOUT knowing their
    // stream key. Used by the BUTT/audio multistream relay, which is triggered by
    // Icecast (not MediaMTX) and so never sees the OBS `fwx_*` stream key.
    const current = url.searchParams.get('current') === '1' || url.searchParams.get('current') === 'true';
    // SECURITY: Only accept server key from headers - never query params (they appear in logs)
    const serverKey = request.headers.get('x-server-key');

    // SECURITY: Require server key for access to Twitch credentials (timing-safe comparison)
    const expectedServerKey = env?.STREAM_SERVER_KEY || import.meta.env.STREAM_SERVER_KEY;
    if (!expectedServerKey || !serverKey || !timingSafeEqual(serverKey, expectedServerKey)) {
      log.warn('Unauthorized access attempt');
      return ApiErrors.forbidden('Unauthorized');
    }

    if (!streamKey && !current) {
      return ApiErrors.badRequest('streamKey or current=1 required');
    }

    // Find the slot: by exact stream key, or — for current=1 — the currently-live
    // slot (the BUTT relay has no stream key to look up by).
    const slots = current
      ? await queryCollection('livestreamSlots', {
          filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
          limit: 5,
          skipCache: true
        })
      : await queryCollection('livestreamSlots', {
          filters: [{ field: 'streamKey', op: 'EQUAL', value: streamKey }],
          limit: 1
        });

    if (slots.length === 0) {
      return jsonResponse({
        success: false,
        error: current ? 'No live slot' : 'Slot not found',
        djTwitchKey: null
      });
    }

    // Prefer a live slot that actually has a personal Twitch key set.
    const slot = slots.find((s) => s.twitchStreamKey) || slots[0];

    return successResponse({ djTwitchKey: slot.twitchStreamKey || null,
      djName: slot.djName || 'Unknown DJ' });

  } catch (error: unknown) {
    log.error('Error:', error);
    return jsonResponse({
      success: false,
      error: 'Internal error',
      djTwitchKey: null
    });
  }
};
