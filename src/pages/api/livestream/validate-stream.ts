// src/pages/api/livestream/validate-stream.ts
// MediaMTX HTTP authentication hook (authMethod: http).
//
// DORMANT: C:\mediamtx\mediamtx.yml still runs `authMethod: internal` with
// MediaMTX's defaults (anyone may publish anywhere), so nothing calls this yet.
// Switch-on checklist at the bottom of this comment.
//
// MediaMTX POSTs JSON { user, password, ip, action, path, protocol, id, query }
// for every action not in authHTTPExclude. Any 2xx = allow, anything else = deny.
// The rules live in src/lib/stream-auth.ts (unit-tested):
//   read / playback          -> allow
//   api / metrics / pprof    -> loopback only (MediaMTX's own default)
//   publish, internal paths  -> loopback over rtmp/rtsp/srt only (the PC's ffmpeg)
//   publish, live/fwx_<key>  -> the key was issued to a DJ (slot history) who has
//                               an active, uncancelled slot now and isn't suspended
//
// Key adoption: stream keys are personal to a DJ, not per session. The first
// slot a key was issued for identifies its owner; after that the same key works
// for any active slot of that owner, so DJs don't re-enter it in OBS each time.
// When the active slot is on a different key, the slot is re-pointed at the key
// actually publishing (Firestore AND D1 — /api/livestream/status reads D1
// first), so listeners get the right HLS path. Slot status is never changed
// here; the go-live flow owns it.
//
// SECURITY (Sep 2026): server-to-server only. This endpoint used to be public
// (GET and POST): anyone holding one of a DJ's old keys — they are in every HLS
// URL — could flip the DJ's booked slot to an unknown "connecting" status,
// which made early start fail, and re-point the slot's key. Now it requires
// STREAM_SERVER_KEY, via HTTP Basic auth from the authHTTPAddress userinfo (the
// user name is ignored) or the x-server-key header. It is in CSRF_SKIP because
// MediaMTX can't do the double-submit cookie. The old Red5 GET is gone.
//
// SWITCH-ON CHECKLIST (mediamtx.yml hot-reloads on save; keep a backup):
//   authMethod: http
//   authHTTPAddress: https://mediamtx:<STREAM_SERVER_KEY>@freshwax.co.uk/api/livestream/validate-stream/
//     - trailing slash required: without it the site answers 308
//     - percent-encode any @ : / ? # in the key
//   authHTTPExclude: read, playback, api, metrics, pprof (as {action: …} items)
//   cloudflared: narrow the WHIP ingress rule to ^/live/fwx_[A-Za-z0-9_-]+/whip/?$
// Then test a real go-live with OBS and with a phone browser, and watch
// C:\mediamtx\mediamtx.log for "authentication failed". Roll back with
// authMethod: internal.

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, queryCollection } from '../../../lib/firebase-rest';
import { RED5_CONFIG, buildHlsUrl, initRed5Env } from '../../../lib/red5';
import { syncSlotStatusToD1 } from '../../../lib/livestream-slots/helpers';
import { classifyStreamAuth, isAuthorizedStreamServer, pickActiveSlot } from '../../../lib/stream-auth';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { createLogger, jsonResponse } from '../../../lib/api-utils';

export const prerender = false;

// Every field nullish: a schema rejection here would deny EVERY publish, so
// stay lenient about what MediaMTX sends (versions differ; id can be null).
const authRequestSchema = z.object({
  user: z.string().nullish(),
  password: z.string().nullish(),
  ip: z.string().nullish(),
  action: z.string().nullish(),
  path: z.string().nullish(),
  protocol: z.string().nullish(),
  id: z.string().nullish(),
  query: z.string().nullish(),
});

const log = createLogger('[validate-stream]');

function deny(reason: string, status = 401): Response {
  return jsonResponse({ valid: false, reason }, status);
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals?.runtime?.env;
  const serverKey = env?.STREAM_SERVER_KEY || import.meta.env.STREAM_SERVER_KEY;

  if (!isAuthorizedStreamServer(request.headers, serverKey)) {
    const rateLimit = checkRateLimit(`validate-stream:${getClientId(request)}`, RateLimiters.standard);
    if (!rateLimit.allowed) return rateLimitResponse(rateLimit.retryAfter!);
    return deny('Unauthorized');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return deny('Invalid JSON', 400);
  }
  const parsed = authRequestSchema.safeParse(body);
  if (!parsed.success) return deny('Invalid request data', 400);
  const req = parsed.data;

  const decision = classifyStreamAuth(req);
  if (decision.kind === 'allow') return jsonResponse({ valid: true });
  if (decision.kind === 'deny') {
    log.warn(`Denied ${req.action || '?'} ${req.path || '?'} (${req.protocol || '?'} from ${req.ip || '?'}): ${decision.reason}`);
    return deny(decision.reason);
  }

  const { streamKey } = decision;
  const keyLabel = `${streamKey.substring(0, 20)}…`;

  try {
    initRed5Env({
      RED5_HLS_URL: env?.RED5_HLS_URL || import.meta.env.RED5_HLS_URL,
      RED5_SIGNING_SECRET: env?.RED5_SIGNING_SECRET || import.meta.env.RED5_SIGNING_SECRET,
    });

    // 1. Ownership: which DJ was this key issued to?
    const keyHistory = await queryCollection('livestreamSlots', {
      filters: [{ field: 'streamKey', op: 'EQUAL', value: streamKey }],
      limit: 10,
      skipCache: true,
    });
    const ownerDjId = keyHistory.find((s) => s.djId)?.djId as string | undefined;
    if (!ownerDjId) {
      log.warn(`Unknown stream key ${keyLabel} (${req.protocol || '?'} from ${req.ip || '?'})`);
      return deny('Stream key not recognised');
    }

    // 2. The owner's active slot. No limit on purpose: an unordered limit
    //    returns the OLDEST N slots by id, which misses a busy DJ's current one.
    const ownerSlots = await queryCollection('livestreamSlots', {
      filters: [{ field: 'djId', op: 'EQUAL', value: ownerDjId }],
      skipCache: true,
    });
    const slot = pickActiveSlot(ownerSlots, streamKey, Date.now(), {
      earlyMs: RED5_CONFIG.security.keyValidityWindow,
      graceMs: RED5_CONFIG.timing.endGracePeriod,
    });
    if (!slot || !slot.id) {
      log.warn(`No active slot for key ${keyLabel} (DJ ${ownerDjId})`);
      return deny('No active slot. Book one or press Go Live first.');
    }

    // 3. Suspended / banned DJs can't publish.
    const artist = await getDocument('artists', ownerDjId);
    if (artist && (artist.suspended || artist.banned)) {
      return deny('Account suspended');
    }

    // 4. Adoption: point the slot at the key that's actually publishing.
    const slotId = String(slot.id);
    const validatedAt = new Date().toISOString();
    if (slot.streamKey !== streamKey) {
      log.info(`Adopting key for DJ ${ownerDjId}: slot ${slotId} ${String(slot.streamKey || '').substring(0, 20)}… -> ${keyLabel}`);
      const adoption = {
        streamKey,
        hlsUrl: buildHlsUrl(streamKey),
        broadcastMode: 'video',
        lastValidation: validatedAt,
      };
      try {
        await updateDocument('livestreamSlots', slotId, adoption);
      } catch (e: unknown) {
        log.warn('Firestore key adoption failed (publish still allowed):', e);
      }
      await syncSlotStatusToD1(env?.DB, slotId, String(slot.status), adoption);
    }

    return jsonResponse({ valid: true, slotId });
  } catch (error: unknown) {
    log.error('Validation error:', error);
    return deny('Validation error', 500);
  }
};
