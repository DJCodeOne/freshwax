// src/pages/api/livestream/youtube-broadcast.ts
// Called by the multistream relay (multistream-relay.ps1) right before it starts
// the YouTube push: idempotently ensures a broadcast exists on the Fresh Wax
// channel bound to the FreshWaxLive key (reuse live -> reuse waiting -> create),
// titles it after the currently-live DJ, and stores the videoId on the live slot
// (D1 + Firestore) so /live gets watch/chat URLs with zero Data-API search lag.
//
// SECURITY: server-to-server only — x-server-key header (STREAM_SERVER_KEY),
// same auth as dj-twitch-key. Listed in CSRF_SKIP.
// Spec: scripts/mediamtx/YOUTUBE-AUTOCREATE-SPEC.md

import type { APIRoute } from 'astro';
import { queryCollection, updateDocument } from '../../../lib/firebase-rest';
import { d1GetLiveSlots, d1UpdateSlotStatus } from '../../../lib/d1-catalog';
import { ensureBroadcast, isYouTubeOAuthConfigured } from '../../../lib/youtube-live';
import { initKVCache } from '../../../lib/kv-cache';
import { logServerError } from '../../../lib/error-logger';
import { invalidateStatusCache } from './status';
import { ApiErrors, createLogger, errorResponse, successResponse, timingSafeCompare } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

const log = createLogger('[youtube-broadcast]');

export const prerender = false;

interface LiveSlot {
  id: string;
  djName?: string;
  title?: string;
  customTitle?: boolean;
  isRelay?: boolean;
  [key: string]: unknown;
}

async function getPrimaryLiveSlot(db: unknown): Promise<LiveSlot | null> {
  // D1 first (same source status.ts trusts), Firestore fallback
  let slots: LiveSlot[] = [];
  if (db) {
    slots = (await d1GetLiveSlots(db as never)) as unknown as LiveSlot[];
  }
  if (!slots.length) {
    slots = (await queryCollection('livestreamSlots', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
      limit: 5,
      skipCache: true,
    })) as unknown as LiveSlot[];
  }
  if (!slots.length) return null;
  // Mirror status.ts primaryStream preference: a real DJ over a relay-in.
  return slots.find((s) => !s.isRelay) || slots[0];
}

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`youtube-broadcast:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals?.runtime?.env;
  initKVCache(env);

  // SECURITY: header only — never query params (they appear in logs)
  const serverKey = request.headers.get('x-server-key');
  const expectedServerKey = env?.STREAM_SERVER_KEY || import.meta.env.STREAM_SERVER_KEY;
  if (!expectedServerKey || !serverKey || !timingSafeCompare(serverKey, expectedServerKey)) {
    log.warn('Unauthorized access attempt');
    return ApiErrors.forbidden('Unauthorized');
  }

  if (!isYouTubeOAuthConfigured(env)) {
    return errorResponse('YouTube OAuth not configured — run /api/admin/youtube-oauth/start', 503);
  }

  try {
    const db = env?.DB;
    const slot = await getPrimaryLiveSlot(db);

    // Custom title verbatim when the DJ set one; otherwise the NEUTRAL default —
    // never auto-insert a DJ's name (operator decision Jul 12: an untitled set
    // must not go out as "«DJ» — Live on Fresh Wax").
    const title = slot?.customTitle && slot.title ? slot.title : 'Fresh Wax Live';
    const description =
      "Jungle & Drum'n'Bass live from Fresh Wax — underground vinyl & digital.\n" +
      'Listen, chat and dig the crates: https://freshwax.co.uk/live';

    const broadcast = await ensureBroadcast(env, { title, description });

    // Store on the live slot — BOTH stores (status.ts reads D1 first).
    if (slot?.id) {
      const youtubeIntegration = {
        videoId: broadcast.videoId,
        chatUrl: broadcast.chatUrl,
        watchUrl: broadcast.watchUrl,
        updatedAt: new Date().toISOString(),
      };
      if (db) {
        await d1UpdateSlotStatus(db as never, slot.id, 'live', {
          youtubeLiveId: broadcast.videoId,
          youtubeIntegration,
        });
      }
      // Partial update — updateDocument, never setDocument (it replaces the doc)
      await updateDocument('livestreamSlots', slot.id, {
        youtubeLiveId: broadcast.videoId,
        youtubeIntegration,
        updatedAt: new Date().toISOString(),
      });
      await invalidateStatusCache();
      log.info('Slot', slot.id, 'updated with YouTube video', broadcast.videoId);
    } else {
      log.warn('No live slot found — broadcast ensured without slot linkage');
    }

    return successResponse({
      videoId: broadcast.videoId,
      watchUrl: broadcast.watchUrl,
      chatUrl: broadcast.chatUrl,
      reused: broadcast.reused,
      slotId: slot?.id || null,
      title,
    });
  } catch (error: unknown) {
    log.error('Error:', error);
    // Surface in /admin/errors — a dead refresh token must not fail silently.
    await logServerError(error, request, env, { endpoint: '/api/livestream/youtube-broadcast', statusCode: 502 });
    return errorResponse(error instanceof Error ? error.message : 'YouTube broadcast setup failed', 502);
  }
};
