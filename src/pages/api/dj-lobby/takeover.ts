// src/pages/api/dj-lobby/takeover.ts
// DJ Takeover request system - Pusher-based (no Firebase onSnapshot)
// Handles takeover requests between DJs for stream handoffs

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createHmac, createHash } from 'crypto';

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

// Pusher configuration (from .env)
const PUSHER_APP_ID = import.meta.env.PUSHER_APP_ID;
const PUSHER_KEY = import.meta.env.PUBLIC_PUSHER_KEY;
const PUSHER_SECRET = import.meta.env.PUSHER_SECRET;
const PUSHER_CLUSTER = import.meta.env.PUBLIC_PUSHER_CLUSTER || 'eu';

// Trigger Pusher event
async function triggerPusher(channel: string, event: string, data: any): Promise<boolean> {
  try {
    const body = JSON.stringify({
      name: event,
      channel: channel,
      data: JSON.stringify(data)
    });
    
    const bodyMd5 = createHash('md5').update(body).digest('hex');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    
    const params = new URLSearchParams({
      auth_key: PUSHER_KEY,
      auth_timestamp: timestamp,
      auth_version: '1.0',
      body_md5: bodyMd5
    });
    params.sort();
    
    const stringToSign = `POST\n/apps/${PUSHER_APP_ID}/events\n${params.toString()}`;
    const signature = createHmac('sha256', PUSHER_SECRET).update(stringToSign).digest('hex');
    
    const url = `https://api-${PUSHER_CLUSTER}.pusher.com/apps/${PUSHER_APP_ID}/events?${params.toString()}&auth_signature=${signature}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    
    if (!response.ok) {
      console.error('[Pusher] Failed:', response.status, await response.text());
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('[Pusher] Error:', error);
    return false;
  }
}

// GET: Get takeover request status for a user
export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');
    const type = url.searchParams.get('type'); // 'incoming' or 'outgoing'
    
    if (!userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User ID required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    if (type === 'incoming') {
      // Check for pending requests targeting this user
      const incomingDoc = await db.collection('djTakeoverRequests').doc(userId).get();
      
      if (incomingDoc.exists) {
        const data = incomingDoc.data();
        if (data?.status === 'pending' && data?.targetDjId === userId) {
          return new Response(JSON.stringify({
            success: true,
            hasRequest: true,
            request: {
              id: incomingDoc.id,
              ...data,
              createdAt: data.createdAt?.toDate?.()?.toISOString()
            }
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
      }
      
      return new Response(JSON.stringify({
        success: true,
        hasRequest: false
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    
    if (type === 'outgoing') {
      // Check for requests made by this user
      const outgoingDoc = await db.collection('djTakeoverRequests').doc(`request_${userId}`).get();
      
      if (outgoingDoc.exists) {
        const data = outgoingDoc.data();
        return new Response(JSON.stringify({
          success: true,
          hasRequest: true,
          request: {
            id: outgoingDoc.id,
            ...data,
            createdAt: data?.createdAt?.toDate?.()?.toISOString()
          }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      return new Response(JSON.stringify({
        success: true,
        hasRequest: false
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Return both if no type specified
    const [incomingDoc, outgoingDoc] = await Promise.all([
      db.collection('djTakeoverRequests').doc(userId).get(),
      db.collection('djTakeoverRequests').doc(`request_${userId}`).get()
    ]);
    
    return new Response(JSON.stringify({
      success: true,
      incoming: incomingDoc.exists ? { id: incomingDoc.id, ...incomingDoc.data() } : null,
      outgoing: outgoingDoc.exists ? { id: outgoingDoc.id, ...outgoingDoc.data() } : null
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    
  } catch (error) {
    console.error('[dj-lobby/takeover] GET Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to get takeover status'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// POST: Create/respond to takeover request
export const POST: APIRoute = async ({ request }) => {
  try {
    const data = await request.json();
    const { action, requesterId, requesterName, requesterAvatar, targetDjId, targetDjName } = data;
    
    if (!requesterId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Requester ID required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    const now = new Date();
    
    switch (action) {
      case 'request': {
        if (!targetDjId) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Target DJ ID required'
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        
        // Create takeover request (stored at target DJ's ID for easy lookup)
        const requestData = {
          requesterId,
          requesterName: requesterName || 'DJ',
          requesterAvatar: requesterAvatar || null,
          targetDjId,
          targetDjName: targetDjName || 'DJ',
          status: 'pending',
          createdAt: now
        };
        
        // Store at target's ID (so target can listen for their doc)
        await db.collection('djTakeoverRequests').doc(targetDjId).set(requestData);
        
        // Also store reference at requester's ID (for tracking outgoing)
        await db.collection('djTakeoverRequests').doc(`request_${requesterId}`).set({
          ...requestData,
          docType: 'outgoing'
        });
        
        // Notify target DJ via Pusher (private channel for that user)
        await triggerPusher(`private-dj-${targetDjId}`, 'takeover-request', {
          ...requestData,
          createdAt: now.toISOString()
        });
        
        // Also broadcast to lobby for visibility
        await triggerPusher('dj-lobby', 'takeover-requested', {
          requesterId,
          requesterName,
          targetDjId,
          targetDjName,
          timestamp: now.toISOString()
        });
        
        return new Response(JSON.stringify({
          success: true,
          message: 'Takeover request sent'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      case 'approve': {
        const { streamKey, serverUrl } = data;
        
        // Get the request
        const requestDoc = await db.collection('djTakeoverRequests').doc(requesterId).get();
        
        if (!requestDoc.exists) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Request not found'
          }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
        
        const requestData = requestDoc.data();
        
        // Update request status
        await db.collection('djTakeoverRequests').doc(requesterId).update({
          status: 'approved',
          approvedAt: now,
          streamKey: streamKey || null,
          serverUrl: serverUrl || 'rtmp://stream.freshwax.co.uk/live'
        });
        
        // Update requester's outgoing doc
        await db.collection('djTakeoverRequests').doc(`request_${requestData?.requesterId}`).update({
          status: 'approved',
          approvedAt: now,
          streamKey: streamKey || null,
          serverUrl: serverUrl || 'rtmp://stream.freshwax.co.uk/live'
        });
        
        // Notify requester via Pusher
        await triggerPusher(`private-dj-${requestData?.requesterId}`, 'takeover-approved', {
          targetDjId: requesterId,
          targetDjName: requestData?.targetDjName,
          streamKey: streamKey || null,
          serverUrl: serverUrl || 'rtmp://stream.freshwax.co.uk/live',
          timestamp: now.toISOString()
        });
        
        // Broadcast to lobby
        await triggerPusher('dj-lobby', 'takeover-approved', {
          requesterId: requestData?.requesterId,
          requesterName: requestData?.requesterName,
          targetDjId: requesterId,
          timestamp: now.toISOString()
        });
        
        return new Response(JSON.stringify({
          success: true,
          message: 'Takeover approved'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      case 'decline': {
        // Get the request
        const requestDoc = await db.collection('djTakeoverRequests').doc(requesterId).get();
        
        if (!requestDoc.exists) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Request not found'
          }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
        
        const requestData = requestDoc.data();
        
        // Update request status
        await db.collection('djTakeoverRequests').doc(requesterId).update({
          status: 'declined',
          declinedAt: now
        });
        
        // Update requester's outgoing doc
        await db.collection('djTakeoverRequests').doc(`request_${requestData?.requesterId}`).update({
          status: 'declined',
          declinedAt: now
        });
        
        // Notify requester via Pusher
        await triggerPusher(`private-dj-${requestData?.requesterId}`, 'takeover-declined', {
          targetDjId: requesterId,
          targetDjName: requestData?.targetDjName,
          timestamp: now.toISOString()
        });
        
        return new Response(JSON.stringify({
          success: true,
          message: 'Takeover declined'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      case 'cancel': {
        // Requester cancels their own request
        const outgoingDoc = await db.collection('djTakeoverRequests').doc(`request_${requesterId}`).get();
        
        if (outgoingDoc.exists) {
          const outgoingData = outgoingDoc.data();
          
          // Delete both documents
          await Promise.all([
            db.collection('djTakeoverRequests').doc(outgoingData?.targetDjId).delete(),
            db.collection('djTakeoverRequests').doc(`request_${requesterId}`).delete()
          ]);
          
          // Notify target that request was cancelled
          await triggerPusher(`private-dj-${outgoingData?.targetDjId}`, 'takeover-cancelled', {
            requesterId,
            timestamp: now.toISOString()
          });
        }
        
        return new Response(JSON.stringify({
          success: true,
          message: 'Request cancelled'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      default:
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid action'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
  } catch (error) {
    console.error('[dj-lobby/takeover] POST Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to process takeover request'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// DELETE: Cleanup expired requests
export const DELETE: APIRoute = async ({ request }) => {
  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    
    // Get old pending requests
    const snapshot = await db.collection('djTakeoverRequests')
      .where('status', '==', 'pending')
      .where('createdAt', '<', fiveMinutesAgo)
      .get();
    
    const batch = db.batch();
    const expiredRequests: string[] = [];
    
    snapshot.forEach(doc => {
      batch.delete(doc.ref);
      expiredRequests.push(doc.id);
    });
    
    // Also cleanup corresponding request_ docs
    for (const id of expiredRequests) {
      const docData = snapshot.docs.find(d => d.id === id)?.data();
      if (docData?.requesterId) {
        batch.delete(db.collection('djTakeoverRequests').doc(`request_${docData.requesterId}`));
      }
    }
    
    if (expiredRequests.length > 0) {
      await batch.commit();
    }
    
    return new Response(JSON.stringify({
      success: true,
      expired: expiredRequests.length
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    
  } catch (error) {
    console.error('[dj-lobby/takeover] DELETE Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Cleanup failed'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
