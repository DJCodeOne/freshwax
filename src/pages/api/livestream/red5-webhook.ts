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
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { RED5_CONFIG, verifyWebhookSignature, type Red5WebhookEvent } from '../../../lib/red5';

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

export const POST: APIRoute = async ({ request }) => {
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
    const slotsQuery = await db.collection('livestreamSlots')
      .where('streamKey', '==', event.streamKey)
      .limit(1)
      .get();
    
    if (slotsQuery.empty) {
      console.warn('[red5-webhook] No slot found for stream key:', event.streamKey);
      return new Response(JSON.stringify({
        success: true,
        message: 'Acknowledged (slot not found)'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    
    const slotDoc = slotsQuery.docs[0];
    const slotRef = slotDoc.ref;
    const slotData = slotDoc.data();
    
    // Handle different event types
    switch (event.event) {
      case 'publish': {
        // Stream has started - update slot to live
        console.log('[red5-webhook] Stream published:', slotData.djName, slotDoc.id);
        
        await slotRef.update({
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
        const livestreamQuery = await db.collection('livestreams')
          .where('streamKey', '==', event.streamKey)
          .limit(1)
          .get();
        
        if (!livestreamQuery.empty) {
          await livestreamQuery.docs[0].ref.update({
            status: 'live',
            isLive: true,
            startedAt: now,
            updatedAt: now,
          });
        } else {
          // Create a new livestream record
          await db.collection('livestreams').add({
            slotId: slotDoc.id,
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
        console.log('[red5-webhook] Stream unpublished:', slotData.djName, slotDoc.id);
        
        const slotEndTime = new Date(slotData.endTime);
        const nowDate = new Date();
        
        // Determine if this was a normal end or early disconnect
        const isEarlyEnd = nowDate < slotEndTime;
        const finalStatus = isEarlyEnd ? 'failed' : 'completed';
        
        await slotRef.update({
          status: finalStatus,
          isLive: false,
          streamEndedAt: now,
          endReason: isEarlyEnd ? 'disconnected' : 'scheduled_end',
          updatedAt: now,
        });
        
        // Update livestreams collection
        const livestreamQuery = await db.collection('livestreams')
          .where('streamKey', '==', event.streamKey)
          .where('isLive', '==', true)
          .limit(1)
          .get();
        
        if (!livestreamQuery.empty) {
          await livestreamQuery.docs[0].ref.update({
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
        await slotRef.update({
          currentViewers: FieldValue.increment(1),
          totalViews: FieldValue.increment(1),
          lastHeartbeat: now,
          updatedAt: now,
        });
        
        // Update peak if current > peak
        const currentData = (await slotRef.get()).data();
        if (currentData && currentData.currentViewers > (currentData.viewerPeak || 0)) {
          await slotRef.update({
            viewerPeak: currentData.currentViewers,
          });
        }
        
        break;
      }
      
      case 'viewer_leave': {
        // Decrement viewer count (minimum 0)
        const currentSlot = (await slotRef.get()).data();
        if (currentSlot && currentSlot.currentViewers > 0) {
          await slotRef.update({
            currentViewers: FieldValue.increment(-1),
            lastHeartbeat: now,
            updatedAt: now,
          });
        }
        break;
      }
      
      case 'record_start':
      case 'record_stop': {
        // Log recording events but no action needed
        console.log('[red5-webhook] Recording event:', event.event, slotDoc.id);
        await slotRef.update({
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
      slotId: slotDoc.id,
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
export const GET: APIRoute = async () => {
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
