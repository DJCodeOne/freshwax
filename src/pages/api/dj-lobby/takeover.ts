// src/pages/api/dj-lobby/takeover.ts
// DJ Takeover request system - uses Firebase REST API
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, setDocument, updateDocument, deleteDocument, queryCollection } from '../../../lib/firebase-rest';
import { ApiErrors, createLogger } from '../../../lib/api-utils';

const log = createLogger('dj-lobby/takeover');
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

const TakeoverSchema = z.object({
  action: z.string().min(1).max(50),
  requesterId: z.string().min(1).max(500),
  requesterName: z.string().max(200).nullish(),
  requesterAvatar: z.string().max(2000).nullish(),
  targetDjId: z.string().max(500).nullish(),
  targetDjName: z.string().max(200).nullish(),
  streamKey: z.string().max(500).nullish(),
  serverUrl: z.string().max(2000).nullish(),
}).passthrough();

// Pusher configuration
const PUSHER_APP_ID = import.meta.env.PUSHER_APP_ID;
const PUSHER_KEY = import.meta.env.PUBLIC_PUSHER_KEY;
const PUSHER_SECRET = import.meta.env.PUSHER_SECRET;
const PUSHER_CLUSTER = import.meta.env.PUBLIC_PUSHER_CLUSTER || 'eu';

// Trigger Pusher event (simplified - may need crypto polyfill)
async function triggerPusher(channel: string, event: string, data: Record<string, unknown>): Promise<boolean> {
  try {
    if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET) {
      log.warn('Pusher not configured');
      return false;
    }

    // Use Pusher HTTP API with basic auth approach
    const body = JSON.stringify({
      name: event,
      channel: channel,
      data: JSON.stringify(data)
    });

    // Note: Full Pusher implementation requires crypto for signing
    // Stub — no-op until Pusher signing is wired up
    return true;
  } catch (error: unknown) {
    log.error('Pusher error:', error);
    return false;
  }
}

// GET: Get takeover request status
export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`takeover-get:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;

  try {
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');
    const type = url.searchParams.get('type');

    if (!userId) {
      return ApiErrors.badRequest('User ID required');
    }

    // SECURITY: Verify the requesting user matches the userId
    const { verifyUserToken } = await import('../../../lib/firebase-rest');
    const authHeader = request.headers.get('Authorization');
    const idToken = authHeader?.replace('Bearer ', '') || undefined;
    if (!idToken) {
      return ApiErrors.unauthorized('Authentication required');
    }
    const verifiedUid = await verifyUserToken(idToken);
    if (!verifiedUid || verifiedUid !== userId) {
      return ApiErrors.forbidden('You can only check your own takeover requests');
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

  } catch (error: unknown) {
    log.error('GET Error:', error);
    return ApiErrors.serverError('Failed to get takeover status');
  }
};

// POST: Create/respond to takeover request
export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimitPost = checkRateLimit(`takeover-post:${clientId}`, RateLimiters.standard);
  if (!rateLimitPost.allowed) {
    return rateLimitResponse(rateLimitPost.retryAfter!);
  }

  const env = locals.runtime.env;

  try {
    const rawBody = await request.json();
    const parseResult = TakeoverSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const data = parseResult.data;
    const { action, requesterId, requesterName, requesterAvatar, targetDjId, targetDjName } = data;

    // SECURITY: Verify the requesting user owns this requesterId
    const authHeader = request.headers.get('Authorization');
    const idToken = authHeader?.replace('Bearer ', '') || undefined;
    const { verifyUserToken } = await import('../../../lib/firebase-rest');

    if (!idToken) {
      return ApiErrors.unauthorized('Authentication required');
    }
    const tokenUserId = await verifyUserToken(idToken);
    if (!tokenUserId || tokenUserId !== requesterId) {
      return ApiErrors.forbidden('You can only create takeover requests as yourself');
    }

    const now = new Date().toISOString();

    switch (action) {
      case 'request': {
        if (!targetDjId) {
          return ApiErrors.badRequest('Target DJ ID required');
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
          return ApiErrors.notFound('Request not found');
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
          return ApiErrors.notFound('Request not found');
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
        return ApiErrors.badRequest('Invalid action');
    }

  } catch (error: unknown) {
    log.error('POST Error:', error);
    return ApiErrors.serverError('Failed to process takeover request');
  }
};

// DELETE: Cleanup expired requests
export const DELETE: APIRoute = async ({ locals }) => {
  const env = locals.runtime.env;

  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const requests = await queryCollection('djTakeoverRequests', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'pending' }],
      skipCache: true,
      limit: 50
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

  } catch (error: unknown) {
    log.error('DELETE Error:', error);
    return ApiErrors.serverError('Cleanup failed');
  }
};
