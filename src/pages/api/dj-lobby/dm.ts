// src/pages/api/dj-lobby/dm.ts
// DJ Direct Messages - Pusher-based real-time (no Firebase onSnapshot)
// Private messages between DJs in the lobby

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, setDocument, deleteDocument, queryCollection, addDocument, initFirebaseEnv, verifyRequestUser } from '../../../lib/firebase-rest';
import { fetchWithTimeout, ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';
import { simpleMd5 } from '../../../lib/pusher';
const log = createLogger('[dj-lobby/dm]');
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

const DmSchema = z.object({
  senderId: z.string().min(1).max(500),
  senderName: z.string().max(200).nullish(),
  receiverId: z.string().min(1).max(500),
  receiverName: z.string().max(200).nullish(),
  text: z.string().min(1).max(2000),
  senderAvatar: z.string().max(2000).nullish(),
}).strip();

// Web Crypto API helper for HMAC-SHA256 (hex output)
async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const dataBuffer = encoder.encode(data);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, dataBuffer);
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Trigger Pusher event using Web Crypto API
async function triggerPusher(channel: string, event: string, data: Record<string, unknown>, env?: Record<string, unknown>): Promise<boolean> {
  // Get Pusher config from env (Cloudflare runtime) or import.meta.env
  const PUSHER_APP_ID = env?.PUSHER_APP_ID || import.meta.env.PUSHER_APP_ID;
  const PUSHER_KEY = env?.PUBLIC_PUSHER_KEY || import.meta.env.PUBLIC_PUSHER_KEY;
  const PUSHER_SECRET = env?.PUSHER_SECRET || import.meta.env.PUSHER_SECRET;
  const PUSHER_CLUSTER = env?.PUBLIC_PUSHER_CLUSTER || import.meta.env.PUBLIC_PUSHER_CLUSTER || 'eu';

  if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET) {
    log.error('[Pusher] Missing configuration');
    return false;
  }

  try {
    const body = JSON.stringify({
      name: event,
      channel: channel,
      data: JSON.stringify(data)
    });

    const bodyMd5 = simpleMd5(body);
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const params = new URLSearchParams({
      auth_key: PUSHER_KEY,
      auth_timestamp: timestamp,
      auth_version: '1.0',
      body_md5: bodyMd5
    });
    params.sort();

    const stringToSign = `POST\n/apps/${PUSHER_APP_ID}/events\n${params.toString()}`;
    const signature = await hmacSha256Hex(PUSHER_SECRET, stringToSign);

    const url = `https://api-${PUSHER_CLUSTER}.pusher.com/apps/${PUSHER_APP_ID}/events?${params.toString()}&auth_signature=${signature}`;

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    }, 5000);

    if (!response.ok) {
      log.error('[Pusher] Failed:', response.status, await response.text());
      return false;
    }

    return true;
  } catch (error: unknown) {
    log.error('[Pusher] Error:', error);
    return false;
  }
}

// Helper to create consistent DM channel ID
function getDmChannelId(uid1: string, uid2: string): string {
  return [uid1, uid2].sort().join('_');
}

// GET: Get DM conversation
export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`dm-get:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // Initialize Firebase for Cloudflare runtime
  const env = locals.runtime.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    // SECURITY: Require authentication and verify userId matches
    const { userId: authUserId, error: authError } = await verifyRequestUser(request);
    if (!authUserId || authError) {
      return ApiErrors.unauthorized('Authentication required');
    }

    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');
    const targetId = url.searchParams.get('targetId');
    const type = url.searchParams.get('type'); // 'messages' or 'conversations'
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);

    if (!userId) {
      return ApiErrors.badRequest('User ID required');
    }

    if (authUserId !== userId) {
      return ApiErrors.forbidden('Access denied');
    }

    // Get list of conversations for this user
    if (type === 'conversations') {
      const conversations = await queryCollection('djDirectMessages', {
        filters: [{ field: 'participants', op: 'ARRAY_CONTAINS', value: userId }],
        orderBy: { field: 'updatedAt', direction: 'DESCENDING' },
        limit: 20,
        skipCache: true
      });

      // Ensure updatedAt is ISO string format
      const formattedConversations = conversations.map(conv => ({
        ...conv,
        updatedAt: conv.updatedAt instanceof Date ? conv.updatedAt.toISOString() : conv.updatedAt
      }));

      return successResponse({ conversations: formattedConversations });
    }

    // Get messages for specific conversation
    if (!targetId) {
      return ApiErrors.badRequest('Target ID required for messages');
    }

    const channelId = getDmChannelId(userId, targetId);

    // Query messages from subcollection
    const messages = await queryCollection(`djDirectMessages/${channelId}/messages`, {
      orderBy: { field: 'createdAt', direction: 'ASCENDING' },
      limit,
      skipCache: true
    });

    // Ensure createdAt is ISO string format
    const formattedMessages = messages.map(msg => ({
      ...msg,
      createdAt: msg.createdAt instanceof Date ? msg.createdAt.toISOString() : msg.createdAt
    }));

    return successResponse({ messages: formattedMessages,
      channelId });

  } catch (error: unknown) {
    log.error('[dj-lobby/dm] GET Error:', error);
    return ApiErrors.serverError('Failed to get messages');
  }
};

// POST: Send a DM
export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimitPost = checkRateLimit(`dm-post:${clientId}`, RateLimiters.standard);
  if (!rateLimitPost.allowed) {
    return rateLimitResponse(rateLimitPost.retryAfter!);
  }

  // Initialize Firebase for Cloudflare runtime
  const env = locals.runtime.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const rawBody = await request.json();
    const parseResult = DmSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { senderId, senderName, receiverId, receiverName, text, senderAvatar } = parseResult.data;

    // SECURITY: Verify the requesting user owns this senderId
    const authHeader = request.headers.get('Authorization');
    const idToken = authHeader?.replace('Bearer ', '') || undefined;
    const { verifyUserToken } = await import('../../../lib/firebase-rest');

    if (!idToken) {
      return ApiErrors.unauthorized('Authentication required');
    }
    const tokenUserId = await verifyUserToken(idToken);
    if (!tokenUserId || tokenUserId !== senderId) {
      return ApiErrors.forbidden('You can only send DMs as yourself');
    }

    const cleanText = text.trim().substring(0, 500);
    const now = new Date();
    const channelId = getDmChannelId(senderId, receiverId);

    // Create the message
    const messageData = {
      senderId,
      senderName: senderName || 'DJ',
      receiverId,
      receiverName: receiverName || 'DJ',
      text: cleanText,
      createdAt: now
    };

    // Add message to subcollection
    const messageResult = await addDocument(`djDirectMessages/${channelId}/messages`, messageData);

    // Update channel metadata
    await setDocument('djDirectMessages', channelId, {
      participants: [senderId, receiverId],
      lastMessage: cleanText.substring(0, 100),
      lastSenderId: senderId,
      lastSenderName: senderName || 'DJ',
      updatedAt: now
    });

    // Notify both users via Pusher (private channels)
    const pusherMessage = {
      id: messageResult.id,
      channelId,
      ...messageData,
      createdAt: now.toISOString()
    };

    // Send to both sender and receiver's private channels — allSettled so one failure doesn't block the other
    await Promise.allSettled([
      triggerPusher(`private-dj-${senderId}`, 'dm-message', pusherMessage, env),
      triggerPusher(`private-dj-${receiverId}`, 'dm-message', pusherMessage, env)
    ]);

    // Also send notification to receiver if they're not in the conversation
    await triggerPusher(`private-dj-${receiverId}`, 'dm-notification', {
      senderId,
      senderName: senderName || 'DJ',
      preview: cleanText.substring(0, 50),
      timestamp: now.toISOString()
    }, env);

    return successResponse({ message: {
        id: messageResult.id,
        ...messageData,
        createdAt: now.toISOString()
      } });

  } catch (error: unknown) {
    log.error('[dj-lobby/dm] POST Error:', error);
    return ApiErrors.serverError('Failed to send message');
  }
};

// DELETE: Delete conversation or clear messages
export const DELETE: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimitDelete = checkRateLimit(`dm-delete:${clientId}`, RateLimiters.standard);
  if (!rateLimitDelete.allowed) {
    return rateLimitResponse(rateLimitDelete.retryAfter!);
  }

  // Initialize Firebase for Cloudflare runtime
  const env = locals.runtime.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');
    const targetId = url.searchParams.get('targetId');
    const action = url.searchParams.get('action'); // 'clear' or 'delete'

    if (!userId || !targetId) {
      return ApiErrors.badRequest('User ID and target ID required');
    }

    // SECURITY: Verify the requesting user owns this userId
    const authHeader = request.headers.get('Authorization');
    const idToken = authHeader?.replace('Bearer ', '') || undefined;
    const { verifyUserToken } = await import('../../../lib/firebase-rest');

    if (!idToken) {
      return ApiErrors.unauthorized('Authentication required');
    }
    const tokenUserId = await verifyUserToken(idToken);
    if (!tokenUserId || tokenUserId !== userId) {
      return ApiErrors.forbidden('You can only delete your own conversations');
    }

    const channelId = getDmChannelId(userId, targetId);

    // Get all messages in the conversation
    const messages = await queryCollection(`djDirectMessages/${channelId}/messages`, {
      skipCache: true
    });

    // Delete all messages
    await Promise.allSettled(messages.map(msg => deleteDocument(`djDirectMessages/${channelId}/messages`, msg.id)));

    // Delete the channel document
    await deleteDocument('djDirectMessages', channelId);

    // Notify both users that conversation was cleared
    await Promise.allSettled([
      triggerPusher(`private-dj-${userId}`, 'dm-cleared', { channelId, targetId }, env),
      triggerPusher(`private-dj-${targetId}`, 'dm-cleared', { channelId, targetId: userId }, env)
    ]);

    return successResponse({ message: 'Conversation deleted' });

  } catch (error: unknown) {
    log.error('[dj-lobby/dm] DELETE Error:', error);
    return ApiErrors.serverError('Failed to delete conversation');
  }
};
