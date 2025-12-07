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
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { RED5_CONFIG, validateStreamKeyTiming, buildHlsUrl } from '../../../lib/red5';

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

export const GET: APIRoute = async ({ request }) => {
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
    
    // Find the slot with this stream key
    const slotsQuery = await db.collection('livestreamSlots')
      .where('streamKey', '==', streamKey)
      .limit(1)
      .get();
    
    if (slotsQuery.empty) {
      return new Response(JSON.stringify({
        valid: false,
        reason: 'Stream key not found. Please book a slot first.',
      }), { 
        status: 403, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    const slotDoc = slotsQuery.docs[0];
    const slot = slotDoc.data();
    
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
      const artistDoc = await db.collection('artists').doc(slot.djId).get();
      if (artistDoc.exists) {
        const artist = artistDoc.data();
        if (artist?.suspended || artist?.banned) {
          return new Response(JSON.stringify({
            valid: false,
            reason: 'Your DJ account is suspended',
          }), { 
            status: 403, 
            headers: { 'Content-Type': 'application/json' } 
          });
        }
      }
    }
    
    // All checks passed - allow the stream
    console.log('[validate-stream] Stream approved for:', slot.djName, 'slot:', slotDoc.id);
    
    // Update slot to show connecting
    await slotDoc.ref.update({
      status: slot.status === 'live' ? 'live' : 'connecting',
      lastValidation: new Date().toISOString(),
    });
    
    return new Response(JSON.stringify({
      valid: true,
      slotId: slotDoc.id,
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

// POST endpoint for alternative validation method
export const POST: APIRoute = async ({ request }) => {
  try {
    const data = await request.json();
    const streamKey = data.key || data.name || data.streamKey || '';
    
    // Redirect to GET handler logic
    const url = new URL(request.url);
    url.searchParams.set('key', streamKey);
    
    const getRequest = new Request(url.toString(), { method: 'GET' });
    return GET({ request: getRequest } as any);
  } catch (error) {
    return new Response(JSON.stringify({
      valid: false,
      reason: 'Invalid request body',
    }), { 
      status: 400, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
};
