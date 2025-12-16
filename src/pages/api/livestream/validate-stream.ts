// src/pages/api/livestream/validate-stream.ts
// Stream Key Validation API - Red5 calls this before allowing a publish
//
// Configure Red5 to call this endpoint for stream authentication:
// GET https://freshwax.co.uk/api/livestream/validate-stream?key={streamKey}
//
// Returns:
// - 200 with { valid: true } if stream is allowed
// - 403 with { valid: false, reason: "..." } if stream is denied

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';
import { RED5_CONFIG, validateStreamKeyTiming, buildHlsUrl, initRed5Env } from '../../../lib/red5';

// Helper to initialize services
function initServices(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
  initRed5Env({
    RED5_SIGNING_SECRET: env?.RED5_SIGNING_SECRET || import.meta.env.RED5_SIGNING_SECRET,
  });
}

export const GET: APIRoute = async ({ request, locals }) => {
  initServices(locals);
  const url = new URL(request.url);
  const streamKey = url.searchParams.get('key') || url.searchParams.get('name') || '';
  
  // Also check for Red5-style parameters
  const app = url.searchParams.get('app') || 'live';
  
  console.log('[validate-stream] Validating stream key:', streamKey?.substring(0, 20) + '...');
  
  if (!streamKey) {
    return new Response(JSON.stringify({
      valid: false,
      reason: 'No stream key provided',
    }), { 
      status: 400, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
  
  try {
    // Check stream key format
    const keyParts = streamKey.split('_');
    if (keyParts.length < 3 || keyParts[0] !== RED5_CONFIG.security.keyPrefix) {
      return new Response(JSON.stringify({
        valid: false,
        reason: 'Invalid stream key format',
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
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
        return new Response(JSON.stringify({
          valid: false,
          reason: 'This stream key was cancelled. Please generate a new one.',
        }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({
        valid: false,
        reason: 'Stream key not found. Please book a slot first.',
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Use the most recent active slot
    const slot = activeSlots.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];
    const slotId = slot.id;
    
    // Check slot status - must be scheduled, in_lobby, or live (for reconnection)
    const allowedStatuses = ['scheduled', 'in_lobby', 'live', 'queued'];
    if (!allowedStatuses.includes(slot.status)) {
      return new Response(JSON.stringify({
        valid: false,
        reason: `Slot is ${slot.status}. Cannot stream.`,
        slotStatus: slot.status,
      }), { 
        status: 403, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    // Validate timing
    const slotStart = new Date(slot.startTime);
    const slotEnd = new Date(slot.endTime);
    const validation = validateStreamKeyTiming(streamKey, slotStart, slotEnd);
    
    if (!validation.valid) {
      return new Response(JSON.stringify({
        valid: false,
        reason: validation.reason,
        tooEarly: validation.tooEarly,
        expired: validation.expired,
        slotStart: slot.startTime,
        slotEnd: slot.endTime,
      }), { 
        status: 403, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    // Check if slot is cancelled
    if (slot.cancelled) {
      return new Response(JSON.stringify({
        valid: false,
        reason: 'This slot has been cancelled',
      }), { 
        status: 403, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    // Check if DJ is banned/suspended (optional)
    if (slot.djId) {
      const artist = await getDocument('artists', slot.djId);
      if (artist && (artist.suspended || artist.banned)) {
        return new Response(JSON.stringify({
          valid: false,
          reason: 'Your DJ account is suspended',
        }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // All checks passed - allow the stream
    console.log('[validate-stream] Stream approved for:', slot.djName, 'slot:', slotId);

    // Update slot to show connecting (non-critical)
    try {
      await updateDocument('livestreamSlots', slotId, {
        status: slot.status === 'live' ? 'live' : 'connecting',
        lastValidation: new Date().toISOString(),
      });
    } catch (updateErr) {
      console.warn('[validate-stream] Non-critical: Failed to update slot:', updateErr);
    }
    
    return new Response(JSON.stringify({
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
    }), { 
      status: 200, 
      headers: { 'Content-Type': 'application/json' } 
    });
    
  } catch (error) {
    console.error('[validate-stream] Error:', error);
    
    // On error, deny the stream to be safe
    return new Response(JSON.stringify({
      valid: false,
      reason: 'Validation service error. Please try again.',
    }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
};

// POST endpoint for MediaMTX HTTP authentication
// MediaMTX sends: { user, password, ip, action, path, protocol, id, query }
// Returns 200 for allowed, non-200 for denied
export const POST: APIRoute = async ({ request, locals }) => {
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

    console.log('[validate-stream] MediaMTX auth:', { action, protocol, streamKey: streamKey?.substring(0, 20) + '...', ip: clientIp });

    // Allow read actions without authentication
    if (action === 'read' || action === 'playback') {
      return new Response(JSON.stringify({ valid: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // For publish actions, validate the stream key
    if (!streamKey) {
      return new Response(JSON.stringify({
        valid: false,
        reason: 'No stream key provided',
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check stream key format
    const keyParts = streamKey.split('_');
    if (keyParts.length < 3 || keyParts[0] !== RED5_CONFIG.security.keyPrefix) {
      return new Response(JSON.stringify({
        valid: false,
        reason: 'Invalid stream key format',
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
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
        return new Response(JSON.stringify({
          valid: false,
          reason: 'Stream key cancelled - generate new',
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({
        valid: false,
        reason: 'Stream key not found',
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
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
      return new Response(JSON.stringify({
        valid: false,
        reason: validation.reason,
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check if slot is cancelled
    if (slot.cancelled) {
      return new Response(JSON.stringify({
        valid: false,
        reason: 'Slot cancelled',
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check if DJ is banned
    if (slot.djId) {
      const artist = await getDocument('artists', slot.djId);
      if (artist && (artist.suspended || artist.banned)) {
        return new Response(JSON.stringify({
          valid: false,
          reason: 'Account suspended',
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // All checks passed - allow the stream
    console.log('[validate-stream] Stream approved:', slot.djName, slotId);

    // Update slot to connecting (non-critical - don't fail validation if this fails)
    try {
      await updateDocument('livestreamSlots', slotId, {
        status: slot.status === 'live' ? 'live' : 'connecting',
        lastValidation: new Date().toISOString(),
        clientIp: clientIp,
      });
    } catch (updateErr) {
      console.warn('[validate-stream] Non-critical: Failed to update slot status:', updateErr);
    }

    // Return 200 to allow the stream
    return new Response(JSON.stringify({
      valid: true,
      slotId: slotId,
      djName: slot.djName,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[validate-stream] Error:', error);
    return new Response(JSON.stringify({
      valid: false,
      reason: 'Validation error',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
