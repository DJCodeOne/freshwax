// src/pages/api/livestream/red5-webhook.ts
// Red5 Pro Webhook Handler - receives stream events from Red5 server
//
// Configure Red5 to send webhooks to:
// POST https://freshwax.co.uk/api/livestream/red5-webhook
//
// Events handled:
// - publish: Stream started
// - unpublish: Stream ended
// - viewer_join: New viewer connected
// - viewer_leave: Viewer disconnected

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, addDocument, queryCollection, incrementField, initFirebaseEnv } from '../../../lib/firebase-rest';
import { RED5_CONFIG, verifyWebhookSignature, type Red5WebhookEvent } from '../../../lib/red5';

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  const now = new Date().toISOString();
  
  try {
    // Get raw body for signature verification
    const rawBody = await request.text();
    
    // Verify webhook signature (if configured)
    const signature = request.headers.get('x-red5-signature') || 
                      request.headers.get('x-webhook-signature') || '';
    
    if (RED5_CONFIG.security.webhookSecret !== 'webhook-secret-change-in-production') {
      // Only verify if a real secret is configured
      if (signature && !verifyWebhookSignature(rawBody, signature)) {
        console.error('[red5-webhook] Invalid signature');
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid webhook signature'
        }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
    }
    
    // Parse the webhook payload
    const event: Red5WebhookEvent = JSON.parse(rawBody);
    
    console.log('[red5-webhook] Received event:', event.event, 'streamKey:', event.streamKey);
    
    // Extract slot info from stream key
    // Format: fwx_{djIdShort}_{slotIdShort}_{timestamp}_{signature}
    const keyParts = event.streamKey?.split('_');
    if (!keyParts || keyParts.length < 3 || keyParts[0] !== RED5_CONFIG.security.keyPrefix) {
      console.warn('[red5-webhook] Unknown stream key format:', event.streamKey);
      // Still return success - we don't want Red5 to retry
      return new Response(JSON.stringify({
        success: true,
        message: 'Acknowledged (unknown key format)'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Find the slot by stream key
    const slots = await queryCollection('livestreamSlots', {
      filters: [{ field: 'streamKey', op: 'EQUAL', value: event.streamKey }],
      limit: 1
    });

    if (slots.length === 0) {
      console.warn('[red5-webhook] No slot found for stream key:', event.streamKey);
      return new Response(JSON.stringify({
        success: true,
        message: 'Acknowledged (slot not found)'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const slotData = slots[0];
    const slotId = slotData.id;
    
    // Handle different event types
    switch (event.event) {
      case 'publish': {
        // Stream has started - update slot to live
        console.log('[red5-webhook] Stream published:', slotData.djName, slotId);

        await updateDocument('livestreamSlots', slotId, {
          status: 'live',
          isLive: true,
          streamStartedAt: now,
          lastHeartbeat: now,
          streamMetadata: {
            clientIp: event.clientIp || null,
            publishedAt: event.timestamp || now,
            ...event.metadata,
          },
          updatedAt: now,
        });

        // Also update the livestreams collection for the status API
        const livestreams = await queryCollection('livestreams', {
          filters: [{ field: 'streamKey', op: 'EQUAL', value: event.streamKey }],
          limit: 1
        });

        if (livestreams.length > 0) {
          await updateDocument('livestreams', livestreams[0].id, {
            status: 'live',
            isLive: true,
            startedAt: now,
            updatedAt: now,
          });
        } else {
          // Create a new livestream record
          await addDocument('livestreams', {
            slotId: slotId,
            djId: slotData.djId,
            djName: slotData.djName,
            djAvatar: slotData.djAvatar,
            title: slotData.title || `${slotData.djName} Live`,
            genre: slotData.genre || 'Jungle / D&B',
            streamKey: event.streamKey,
            streamType: 'red5',
            streamSource: 'red5',
            hlsUrl: `${RED5_CONFIG.server.hlsBaseUrl}/${event.streamKey}/index.m3u8`,
            status: 'live',
            isLive: true,
            startedAt: now,
            endedAt: null,
            currentViewers: 0,
            peakViewers: 0,
            totalViews: 0,
            totalLikes: 0,
            createdAt: now,
            updatedAt: now,
          });
        }

        break;
      }
      
      case 'unpublish': {
        // Stream has ended
        console.log('[red5-webhook] Stream unpublished:', slotData.djName, slotId);

        const slotEndTime = new Date(slotData.endTime);
        const nowDate = new Date();

        // Determine if this was a normal end or early disconnect
        const isEarlyEnd = nowDate < slotEndTime;
        const finalStatus = isEarlyEnd ? 'failed' : 'completed';

        await updateDocument('livestreamSlots', slotId, {
          status: finalStatus,
          isLive: false,
          streamEndedAt: now,
          endReason: isEarlyEnd ? 'disconnected' : 'scheduled_end',
          updatedAt: now,
        });

        // Update livestreams collection
        const livestreams = await queryCollection('livestreams', {
          filters: [
            { field: 'streamKey', op: 'EQUAL', value: event.streamKey },
            { field: 'isLive', op: 'EQUAL', value: true }
          ],
          limit: 1
        });

        if (livestreams.length > 0) {
          await updateDocument('livestreams', livestreams[0].id, {
            status: 'offline',
            isLive: false,
            endedAt: now,
            updatedAt: now,
          });
        }

        break;
      }
      
      case 'viewer_join': {
        // Increment viewer count
        await incrementField('livestreamSlots', slotId, 'currentViewers', 1);
        await incrementField('livestreamSlots', slotId, 'totalViews', 1);
        await updateDocument('livestreamSlots', slotId, {
          lastHeartbeat: now,
          updatedAt: now,
        });

        // Update peak if current > peak
        const currentData = await getDocument('livestreamSlots', slotId);
        if (currentData && currentData.currentViewers > (currentData.viewerPeak || 0)) {
          await updateDocument('livestreamSlots', slotId, {
            viewerPeak: currentData.currentViewers,
          });
        }

        break;
      }

      case 'viewer_leave': {
        // Decrement viewer count (minimum 0)
        const currentSlot = await getDocument('livestreamSlots', slotId);
        if (currentSlot && currentSlot.currentViewers > 0) {
          await incrementField('livestreamSlots', slotId, 'currentViewers', -1);
          await updateDocument('livestreamSlots', slotId, {
            lastHeartbeat: now,
            updatedAt: now,
          });
        }
        break;
      }
      
      case 'record_start':
      case 'record_stop': {
        // Log recording events but no action needed
        console.log('[red5-webhook] Recording event:', event.event, slotId);
        await updateDocument('livestreamSlots', slotId, {
          [`recordingEvents.${event.event}`]: now,
          updatedAt: now,
        });
        break;
      }
      
      default: {
        console.log('[red5-webhook] Unknown event type:', event.event);
      }
    }
    
    return new Response(JSON.stringify({
      success: true,
      event: event.event,
      slotId: slotId,
      processed: true,
    }), { 
      status: 200, 
      headers: { 'Content-Type': 'application/json' } 
    });
    
  } catch (error) {
    console.error('[red5-webhook] Error processing webhook:', error);
    
    // Still return 200 to prevent Red5 from retrying
    // Log the error for investigation
    return new Response(JSON.stringify({
      success: false,
      error: 'Internal processing error',
      acknowledged: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
};

// GET endpoint for testing/health check
export const GET: APIRoute = async ({ locals }) => {
  initFirebase(locals);
  return new Response(JSON.stringify({
    status: 'ok',
    endpoint: 'Red5 Webhook Handler',
    timestamp: new Date().toISOString(),
    config: {
      rtmpUrl: RED5_CONFIG.server.rtmpUrl,
      hlsBaseUrl: RED5_CONFIG.server.hlsBaseUrl,
      keyPrefix: RED5_CONFIG.security.keyPrefix,
    },
  }), { 
    status: 200, 
    headers: { 'Content-Type': 'application/json' } 
  });
};
