// src/pages/api/livestream/validate-stream.ts
// Stream Key Validation API - Red5 calls this before allowing a publish
//
// Configure Red5 to call this endpoint for stream authentication:
// GET https://freshwax.co.uk/api/livestream/validate-stream/?key={streamKey}
//
// Returns:
// - 200 with { valid: true } if stream is allowed
// - 403 with { valid: false, reason: "..." } if stream is denied

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, queryCollection } from '../../../lib/firebase-rest';
import { RED5_CONFIG, validateStreamKeyTiming, buildHlsUrl, initRed5Env } from '../../../lib/red5';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { createLogger, jsonResponse } from '../../../lib/api-utils';

const validateStreamSchema = z.object({
  path: z.string().optional(),
  key: z.string().optional(),
  name: z.string().optional(),
  streamKey: z.string().optional(),
  action: z.string().optional(),
  protocol: z.string().optional(),
  ip: z.string().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  id: z.string().optional(),
  query: z.string().optional(),
});

const log = createLogger('[validate-stream]');

// Helper to initialize services
function initServices(locals: App.Locals) {
  const env = locals?.runtime?.env;
  initRed5Env({
    RED5_SIGNING_SECRET: env?.RED5_SIGNING_SECRET || import.meta.env.RED5_SIGNING_SECRET,
  });
}

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`validate-stream-get:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  initServices(locals);
  const url = new URL(request.url);
  const streamKey = url.searchParams.get('key') || url.searchParams.get('name') || '';
  
  // Also check for Red5-style parameters
  const app = url.searchParams.get('app') || 'live';
  
  log.info('[validate-stream] Validating stream key:', streamKey?.substring(0, 20) + '...');
  
  if (!streamKey) {
    return jsonResponse({
      valid: false,
      reason: 'No stream key provided',
    }, 400);
  }
  
  try {
    // Check stream key format
    const keyParts = streamKey.split('_');
    if (keyParts.length < 3 || keyParts[0] !== RED5_CONFIG.security.keyPrefix) {
      return jsonResponse({
        valid: false,
        reason: 'Invalid stream key format',
      }, 403);
    }

    // Key adoption model — see POST handler below for the full rationale.
    // Step 1: identify owner via key history.
    const keyHistorySlots = await queryCollection('livestreamSlots', {
      filters: [{ field: 'streamKey', op: 'EQUAL', value: streamKey }],
      limit: 10,
      skipCache: true
    });

    if (keyHistorySlots.length === 0) {
      return jsonResponse({
        valid: false,
        reason: 'Stream key not recognised. Please book a slot first.',
      }, 403);
    }

    const ownerDjId = keyHistorySlots[0].djId as string;
    if (!ownerDjId) {
      return jsonResponse({ valid: false, reason: 'Key ownership unclear' }, 403);
    }

    // Step 2: find owner's currently active slot
    const ownerActiveSlots = await queryCollection('livestreamSlots', {
      filters: [{ field: 'djId', op: 'EQUAL', value: ownerDjId }],
      limit: 20,
      skipCache: true
    });

    const allowedStatuses = ['scheduled', 'in_lobby', 'live', 'queued', 'connecting'];
    const activeSlot = ownerActiveSlots
      .filter(s => allowedStatuses.includes(s.status as string))
      .filter(s => !s.cancelled)
      .filter(s => {
        const startWin = new Date(s.startTime).getTime() - RED5_CONFIG.security.keyValidityWindow;
        const endWin = new Date(s.endTime).getTime() + RED5_CONFIG.timing.endGracePeriod;
        const nowMs = Date.now();
        return nowMs >= startWin && nowMs <= endWin;
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

    if (!activeSlot) {
      return jsonResponse({
        valid: false,
        reason: 'No active slot booked for this DJ.',
      }, 403);
    }

    const slot = activeSlot;
    const slotId = slot.id;
    
    // Validate timing
    const slotStart = new Date(slot.startTime);
    const slotEnd = new Date(slot.endTime);
    const validation = validateStreamKeyTiming(streamKey, slotStart, slotEnd);
    
    if (!validation.valid) {
      return jsonResponse({
        valid: false,
        reason: validation.reason,
        tooEarly: validation.tooEarly,
        expired: validation.expired,
        slotStart: slot.startTime,
        slotEnd: slot.endTime,
      }, 403);
    }
    
    // Check if slot is cancelled
    if (slot.cancelled) {
      return jsonResponse({
        valid: false,
        reason: 'This slot has been cancelled',
      }, 403);
    }
    
    // Check if DJ is banned/suspended (optional)
    if (slot.djId) {
      const artist = await getDocument('artists', slot.djId);
      if (artist && (artist.suspended || artist.banned)) {
        return jsonResponse({
          valid: false,
          reason: 'Your DJ account is suspended',
        }, 403);
      }
    }

    // All checks passed - allow the stream
    log.info('[validate-stream] Stream approved for:', slot.djName, 'slot:', slotId);

    // Update slot to show connecting (non-critical)
    try {
      await updateDocument('livestreamSlots', slotId, {
        status: slot.status === 'live' ? 'live' : 'connecting',
        lastValidation: new Date().toISOString(),
      });
    } catch (updateErr: unknown) {
      log.warn('[validate-stream] Non-critical: Failed to update slot:', updateErr);
    }
    
    return jsonResponse({
      valid: true,
      slotId: slotId,
      djId: slot.djId,
      djName: slot.djName,
      title: slot.title,
      startTime: slot.startTime,
      endTime: slot.endTime,
      hlsUrl: buildHlsUrl(streamKey),
      // Additional info Red5 might need
      metadata: {
        genre: slot.genre,
        crew: slot.crew,
      },
    });
    
  } catch (error: unknown) {
    log.error('[validate-stream] Error:', error);
    
    // On error, deny the stream to be safe
    return jsonResponse({
      valid: false,
      reason: 'Validation service error. Please try again.',
    }, 500);
  }
};

// POST endpoint for MediaMTX HTTP authentication
// AUTH: Server-to-server auth — MediaMTX sends stream key as the path/password.
// The stream key is validated against active livestream slots.
// MediaMTX sends: { user, password, ip, action, path, protocol, id, query }
// Returns 200 for allowed, non-200 for denied
export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimitPost = checkRateLimit(`validate-stream-post:${clientId}`, RateLimiters.standard);
  if (!rateLimitPost.allowed) {
    return rateLimitResponse(rateLimitPost.retryAfter!);
  }

  initServices(locals);

  try {
    const data = await request.json();
    const parseResult = validateStreamSchema.safeParse(data);
    if (!parseResult.success) {
      return jsonResponse({ valid: false, reason: 'Invalid request data' }, 400);
    }
    const validatedData = parseResult.data;

    // MediaMTX format: path contains the stream key
    // Path format: "streamKey" or "live/streamKey"
    let streamKey = validatedData.path || validatedData.key || validatedData.name || validatedData.streamKey || '';

    // Remove leading slash and "live/" prefix if present
    streamKey = streamKey.replace(/^\/?(live\/)?/, '');

    const action = validatedData.action || 'publish';
    const protocol = validatedData.protocol || 'rtmp';
    const clientIp = validatedData.ip || '';

    log.info('[validate-stream] MediaMTX auth:', { action, protocol, streamKey: streamKey?.substring(0, 20) + '...', ip: clientIp });

    // Allow read actions without authentication
    if (action === 'read' || action === 'playback') {
      return jsonResponse({ valid: true });
    }

    // For publish actions, validate the stream key
    if (!streamKey) {
      return jsonResponse({
        valid: false,
        reason: 'No stream key provided',
      }, 401);
    }

    // Check stream key format
    const keyParts = streamKey.split('_');
    if (keyParts.length < 3 || keyParts[0] !== RED5_CONFIG.security.keyPrefix) {
      return jsonResponse({
        valid: false,
        reason: 'Invalid stream key format',
      }, 401);
    }

    // -----------------------------------------------------------------
    // Key adoption model: stream keys are personal to a DJ rather than
    // per-session. The first slot a key was generated for permanently
    // identifies its owner; from then on, the same key keeps working
    // across future sessions as long as the owner has *some* active
    // slot booked. DJs no longer need to update their OBS profile each
    // time they go live.
    //
    // Auth flow:
    //   1. Look up the slot history for this exact key — that establishes
    //      ownership (which DJ this key belongs to). Cancelled / completed
    //      slots count for ownership; we just need the djId.
    //   2. Find the owner's *currently active* slot (any status the DJ
    //      could legitimately be streaming into).
    //   3. Validate timing against the active slot. The key's encoded
    //      timestamp is irrelevant — what matters is the owner has a
    //      booked slot right now.
    //
    // A different DJ trying to publish using someone else's key fails
    // step 2 because the key's owner won't be them, and the slot lookup
    // is owner-scoped. Genuine sharing is still an account compromise
    // (same as Twitch / Stream Deck) — handle that with key rotation.
    // -----------------------------------------------------------------

    // Step 1: identify the owning DJ via key history
    const keyHistorySlots = await queryCollection('livestreamSlots', {
      filters: [{ field: 'streamKey', op: 'EQUAL', value: streamKey }],
      limit: 10,
      skipCache: true
    });

    if (keyHistorySlots.length === 0) {
      log.warn('[validate-stream] Unknown stream key (never assigned):', streamKey.substring(0, 20) + '...');
      return jsonResponse({
        valid: false,
        reason: 'Stream key not recognised',
      }, 401);
    }

    // All slots with this key should belong to the same DJ (keys are
    // signed per-DJ). Take the first.
    const ownerDjId = keyHistorySlots[0].djId as string;
    const ownerDjName = keyHistorySlots[0].djName as string;

    if (!ownerDjId) {
      log.error('[validate-stream] Key history slot has no djId:', keyHistorySlots[0].id);
      return jsonResponse({ valid: false, reason: 'Key ownership unclear' }, 401);
    }

    // Step 2: find owner's currently active slot
    const ownerActiveSlots = await queryCollection('livestreamSlots', {
      filters: [{ field: 'djId', op: 'EQUAL', value: ownerDjId }],
      limit: 20,
      skipCache: true
    });

    const allowedStatuses = ['scheduled', 'in_lobby', 'live', 'queued', 'connecting'];
    const activeSlot = ownerActiveSlots
      .filter(s => allowedStatuses.includes(s.status as string))
      .filter(s => !s.cancelled)
      // Slot's window must include now (with the same grace as the timing check).
      // Don't accept publishes against far-future or far-past slots.
      .filter(s => {
        const startWin = new Date(s.startTime).getTime() - RED5_CONFIG.security.keyValidityWindow;
        const endWin = new Date(s.endTime).getTime() + RED5_CONFIG.timing.endGracePeriod;
        const nowMs = Date.now();
        return nowMs >= startWin && nowMs <= endWin;
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

    if (!activeSlot) {
      log.warn(`[validate-stream] ${ownerDjName} has no active slot for publish (key=${streamKey.substring(0, 20)}...)`);
      return jsonResponse({
        valid: false,
        reason: 'No active slot booked. Schedule one or use Go Live first.',
      }, 401);
    }

    const slot = activeSlot;
    const slotId = slot.id;

    // Step 3: timing + ban + final checks against the active slot
    const slotStart = new Date(slot.startTime);
    const slotEnd = new Date(slot.endTime);
    const validation = validateStreamKeyTiming(streamKey, slotStart, slotEnd);
    if (!validation.valid) {
      return jsonResponse({ valid: false, reason: validation.reason }, 401);
    }

    if (slot.djId) {
      const artist = await getDocument('artists', slot.djId);
      if (artist && (artist.suspended || artist.banned)) {
        return jsonResponse({ valid: false, reason: 'Account suspended' }, 401);
      }
    }

    // Adoption: if the active slot's streamKey is different from what the
    // DJ is publishing with, point the slot at the actual key being used
    // so listeners' /live page renders the correct HLS path. This is the
    // server-side complement of the auto-adopt in handleGoLive.
    const updates: Record<string, unknown> = {
      status: slot.status === 'live' ? 'live' : 'connecting',
      lastValidation: new Date().toISOString(),
      clientIp: clientIp,
    };
    if (slot.streamKey !== streamKey) {
      log.info(`[validate-stream] Adopting personal key for ${ownerDjName}: slot ${slot.streamKey} → ${streamKey}`);
      updates.streamKey = streamKey;
      // Build the matching playback URL — same shape buildHlsUrl produces.
      updates.hlsUrl = `${RED5_CONFIG.server.hlsBaseUrl.replace(/\/$/, '').replace(/\/live$/, '')}/live/${streamKey}/index.m3u8`;
      updates.broadcastMode = 'video';
    }

    try {
      await updateDocument('livestreamSlots', slotId, updates);
    } catch (updateErr: unknown) {
      log.warn('[validate-stream] Non-critical: Failed to update slot:', updateErr);
    }

    log.info('[validate-stream] Stream approved:', ownerDjName, slotId);
    return jsonResponse({
      valid: true,
      slotId: slotId,
      djName: ownerDjName,
    });

  } catch (error: unknown) {
    log.error('[validate-stream] Error:', error);
    return jsonResponse({
      valid: false,
      reason: 'Validation error',
    }, 500);
  }
};
