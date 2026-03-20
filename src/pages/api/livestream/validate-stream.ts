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
import { getDocument, updateDocument, queryCollection } from '../../../lib/firebase-rest';
import { RED5_CONFIG, validateStreamKeyTiming, buildHlsUrl, initRed5Env } from '../../../lib/red5';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { createLogger, jsonResponse } from '../../../lib/api-utils';

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

    // Find the slot with this stream key (skip cache for real-time validation)
    const allSlots = await queryCollection('livestreamSlots', {
      filters: [{ field: 'streamKey', op: 'EQUAL', value: streamKey }],
      skipCache: true
    });

    // Filter out cancelled slots and find the most recent active one
    const activeSlots = allSlots.filter(s => s.status !== 'cancelled' && !s.cancelled);

    if (activeSlots.length === 0) {
      // Check if there was a cancelled slot with this key
      if (allSlots.length > 0) {
        return jsonResponse({
          valid: false,
          reason: 'This stream key was cancelled. Please generate a new one.',
        }, 403);
      }
      return jsonResponse({
        valid: false,
        reason: 'Stream key not found. Please book a slot first.',
      }, 403);
    }

    // Use the most recent active slot
    const slot = activeSlots.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];
    const slotId = slot.id;
    
    // Check slot status - must be scheduled, in_lobby, or live (for reconnection)
    const allowedStatuses = ['scheduled', 'in_lobby', 'live', 'queued'];
    if (!allowedStatuses.includes(slot.status)) {
      return jsonResponse({
        valid: false,
        reason: `Slot is ${slot.status}. Cannot stream.`,
        slotStatus: slot.status,
      }, 403);
    }
    
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

    // MediaMTX format: path contains the stream key
    // Path format: "streamKey" or "live/streamKey"
    let streamKey = data.path || data.key || data.name || data.streamKey || '';

    // Remove leading slash and "live/" prefix if present
    streamKey = streamKey.replace(/^\/?(live\/)?/, '');

    const action = data.action || 'publish';
    const protocol = data.protocol || 'rtmp';
    const clientIp = data.ip || '';

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

    // Find the slot with this stream key (skip cache for real-time validation)
    const allSlots = await queryCollection('livestreamSlots', {
      filters: [{ field: 'streamKey', op: 'EQUAL', value: streamKey }],
      skipCache: true
    });

    // Filter out cancelled slots and find the most recent active one
    const activeSlots = allSlots.filter(s => s.status !== 'cancelled' && !s.cancelled);

    if (activeSlots.length === 0) {
      // Provide helpful message if key was cancelled
      if (allSlots.length > 0) {
        return jsonResponse({
          valid: false,
          reason: 'Stream key cancelled - generate new',
        }, 401);
      }
      return jsonResponse({
        valid: false,
        reason: 'Stream key not found',
      }, 401);
    }

    // Use the most recent active slot
    const slot = activeSlots.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];
    const slotId = slot.id;

    // Validate timing
    const slotStart = new Date(slot.startTime);
    const slotEnd = new Date(slot.endTime);
    const validation = validateStreamKeyTiming(streamKey, slotStart, slotEnd);

    if (!validation.valid) {
      return jsonResponse({
        valid: false,
        reason: validation.reason,
      }, 401);
    }

    // Check if slot is cancelled
    if (slot.cancelled) {
      return jsonResponse({
        valid: false,
        reason: 'Slot cancelled',
      }, 401);
    }

    // Check if DJ is banned
    if (slot.djId) {
      const artist = await getDocument('artists', slot.djId);
      if (artist && (artist.suspended || artist.banned)) {
        return jsonResponse({
          valid: false,
          reason: 'Account suspended',
        }, 401);
      }
    }

    // All checks passed - allow the stream
    log.info('[validate-stream] Stream approved:', slot.djName, slotId);

    // Update slot to connecting (non-critical - don't fail validation if this fails)
    try {
      await updateDocument('livestreamSlots', slotId, {
        status: slot.status === 'live' ? 'live' : 'connecting',
        lastValidation: new Date().toISOString(),
        clientIp: clientIp,
      });
    } catch (updateErr: unknown) {
      log.warn('[validate-stream] Non-critical: Failed to update slot status:', updateErr);
    }

    // Return 200 to allow the stream
    return jsonResponse({
      valid: true,
      slotId: slotId,
      djName: slot.djName,
    });

  } catch (error: unknown) {
    log.error('[validate-stream] Error:', error);
    return jsonResponse({
      valid: false,
      reason: 'Validation error',
    }, 500);
  }
};
