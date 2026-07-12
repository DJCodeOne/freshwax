// src/pages/api/livestream/twitch-live-check.ts
// Debug/ops probe: what does the WORKER see when it checks a Twitch channel's
// liveness? Twitch serves different HTML to Cloudflare egress than to
// residential IPs, so local curls can't diagnose the checkTwitchLive gate
// (learned Jul 12 when an offline channel matched the bare substring).
// SECURITY: x-server-key gated, same as youtube-broadcast.

import type { APIRoute } from 'astro';
import { checkTwitchLive } from '../../../lib/relay-stations';
import { fetchWithTimeout, ApiErrors, jsonResponse, timingSafeCompare } from '../../../lib/api-utils';
import { TIMEOUTS } from '../../../lib/timeouts';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const env = locals?.runtime?.env;
  const serverKey = request.headers.get('x-server-key');
  const expected = env?.STREAM_SERVER_KEY || import.meta.env.STREAM_SERVER_KEY;
  if (!expected || !serverKey || !timingSafeCompare(serverKey, expected)) {
    return ApiErrors.forbidden('Unauthorized');
  }

  const channel = new URL(request.url).searchParams.get('channel');
  if (!channel || !/^[a-zA-Z0-9_]{2,30}$/.test(channel)) {
    return ApiErrors.badRequest('channel required');
  }

  try {
    const res = await fetchWithTimeout(`https://www.twitch.tv/${channel}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FreshWax/1.0; +https://freshwax.co.uk)' },
    }, TIMEOUTS.SHORT);
    const html = await res.text();
    const bareCount = (html.match(/isLiveBroadcast/g) || []).length;
    const strict = /"isLiveBroadcast"\s*:\s*true/.test(html);
    const gate = await checkTwitchLive(channel);
    return jsonResponse({
      success: true,
      channel,
      httpStatus: res.status,
      bytes: html.length,
      bareMarkerCount: bareCount,
      strictLiveMarker: strict,
      gateResult: gate,
      // small context windows around matches, for eyeballing what Twitch sends
      samples: [...html.matchAll(/.{40}isLiveBroadcast.{40}/gs)].slice(0, 3).map((m) => m[0]),
    });
  } catch (error: unknown) {
    return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'fetch failed' }, 502);
  }
};
