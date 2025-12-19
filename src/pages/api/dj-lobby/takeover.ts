// src/pages/api/dj-lobby/takeover.ts
// DJ Takeover request system - uses Firebase REST API
import type { APIRoute } from 'astro';
import { getDocument, setDocument, updateDocument, deleteDocument, queryCollection , initFirebaseEnv } from '../../../lib/firebase-rest';

// Pusher configuration
const PUSHER_APP_ID = import.meta.env.PUSHER_APP_ID;
const PUSHER_KEY = import.meta.env.PUBLIC_PUSHER_KEY;
const PUSHER_SECRET = import.meta.env.PUSHER_SECRET;
const PUSHER_CLUSTER = import.meta.env.PUBLIC_PUSHER_CLUSTER || 'eu';

// Trigger Pusher event (simplified - may need crypto polyfill)
async function triggerPusher(channel: string, event: string, data: any): Promise<boolean> {
  try {
    if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET) {
      console.warn('[Pusher] Not configured');
      return false;
    }

    // Use Pusher HTTP API with basic auth approach
    const body = JSON.stringify({
      name: event,
      channel: channel,
      data: JSON.stringify(data)
    });

    // Note: Full Pusher implementation requires crypto for signing
    // For now, log and skip if crypto unavailable
    console.log('[Pusher] Would trigger:', channel, event);
    return true;
  } catch (error) {
    console.error('[Pusher] Error:', error);
    return false;
  }
}

// GET: Get takeover request status
export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');
    const type = url.searchParams.get('type');

    if (!userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User ID required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (type === 'incoming') {
      const incomingDoc = await getDocument('djTakeoverRequests', userId);

      if (incomingDoc && incomingDoc.status === 'pending' && incomingDoc.targetDjId === userId) {
        return new Response(JSON.stringify({
          success: true,
          hasRequest: true,
          request: {
            id: userId,
            ...incomingDoc,
            createdAt: incomingDoc.createdAt
          }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({
        success: true,
        hasRequest: false
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (type === 'outgoing') {
      const outgoingDoc = await getDocument('djTakeoverRequests', `request_${userId}`);

      if (outgoingDoc) {
        return new Response(JSON.stringify({
          success: true,
          hasRequest: true,
          request: {
            id: `request_${userId}`,
            ...outgoingDoc
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
      getDocument('djTakeoverRequests', userId),
      getDocument('djTakeoverRequests', `request_${userId}`)
    ]);

    return new Response(JSON.stringify({
      success: true,
      incoming: incomingDoc || null,
      outgoing: outgoingDoc || null
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

    const now = new Date().toISOString();

    switch (action) {
      case 'request': {
        if (!targetDjId) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Target DJ ID required'
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }

        const requestData = {
          requesterId,
          requesterName: requesterName || 'DJ',
          requesterAvatar: requesterAvatar || null,
          targetDjId,
          targetDjName: targetDjName || 'DJ',
          status: 'pending',
          createdAt: now
        };

        await setDocument('djTakeoverRequests', targetDjId, requestData);
        await setDocument('djTakeoverRequests', `request_${requesterId}`, {
          ...requestData,
          docType: 'outgoing'
        });

        await triggerPusher(`private-dj-${targetDjId}`, 'takeover-request', requestData);
        await triggerPusher('dj-lobby', 'takeover-requested', {
          requesterId,
          requesterName,
          targetDjId,
          targetDjName,
          timestamp: now
        });

        return new Response(JSON.stringify({
          success: true,
          message: 'Takeover request sent'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      case 'approve': {
        const { streamKey, serverUrl } = data;

        const requestDoc = await getDocument('djTakeoverRequests', requesterId);

        if (!requestDoc) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Request not found'
          }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }

        await updateDocument('djTakeoverRequests', requesterId, {
          status: 'approved',
          approvedAt: now,
          streamKey: streamKey || null,
          serverUrl: serverUrl || 'rtmp://rtmp.freshwax.co.uk/live'
        });

        await updateDocument('djTakeoverRequests', `request_${requestDoc.requesterId}`, {
          status: 'approved',
          approvedAt: now,
          streamKey: streamKey || null,
          serverUrl: serverUrl || 'rtmp://rtmp.freshwax.co.uk/live'
        });

        await triggerPusher(`private-dj-${requestDoc.requesterId}`, 'takeover-approved', {
          targetDjId: requesterId,
          targetDjName: requestDoc.targetDjName,
          streamKey: streamKey || null,
          serverUrl: serverUrl || 'rtmp://rtmp.freshwax.co.uk/live',
          timestamp: now
        });

        return new Response(JSON.stringify({
          success: true,
          message: 'Takeover approved'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      case 'decline': {
        const requestDoc = await getDocument('djTakeoverRequests', requesterId);

        if (!requestDoc) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Request not found'
          }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }

        await updateDocument('djTakeoverRequests', requesterId, {
          status: 'declined',
          declinedAt: now
        });

        await updateDocument('djTakeoverRequests', `request_${requestDoc.requesterId}`, {
          status: 'declined',
          declinedAt: now
        });

        await triggerPusher(`private-dj-${requestDoc.requesterId}`, 'takeover-declined', {
          targetDjId: requesterId,
          targetDjName: requestDoc.targetDjName,
          timestamp: now
        });

        return new Response(JSON.stringify({
          success: true,
          message: 'Takeover declined'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      case 'cancel': {
        const outgoingDoc = await getDocument('djTakeoverRequests', `request_${requesterId}`);

        if (outgoingDoc) {
          await Promise.all([
            deleteDocument('djTakeoverRequests', outgoingDoc.targetDjId),
            deleteDocument('djTakeoverRequests', `request_${requesterId}`)
          ]);

          await triggerPusher(`private-dj-${outgoingDoc.targetDjId}`, 'takeover-cancelled', {
            requesterId,
            timestamp: now
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
export const DELETE: APIRoute = async ({ locals }) => {
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const requests = await queryCollection('djTakeoverRequests', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'pending' }],
      skipCache: true
    });

    const expiredRequests = requests.filter(r => r.createdAt && r.createdAt < fiveMinutesAgo);

    for (const req of expiredRequests) {
      await deleteDocument('djTakeoverRequests', req.id);
      if (req.requesterId) {
        await deleteDocument('djTakeoverRequests', `request_${req.requesterId}`);
      }
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
