// src/pages/api/dj-lobby/chat.ts
// DJ Lobby chat - Pusher-based real-time (no Firebase onSnapshot)
// Messages stored in Firebase, delivered via Pusher

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, deleteDocument, queryCollection, addDocument, initFirebaseEnv, verifyRequestUser } from '../../../lib/firebase-rest';
import { checkRateLimit as checkGlobalRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { isAdmin, initAdminEnv } from '../../../lib/admin';
import { fetchWithTimeout, ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';
import { simpleMd5 } from '../../../lib/pusher';
const log = createLogger('[dj-lobby/chat]');

const LobbyChatSchema = z.object({
  userId: z.string().min(1).max(500),
  name: z.string().max(200).nullish(),
  text: z.string().min(1).max(2000),
  avatar: z.string().max(2000).nullish(),
}).passthrough();

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

// Rate limiting per user
const rateLimits = new Map<string, number>();
const RATE_LIMIT_MS = 1000; // 1 message per second

function checkRateLimit(userId: string): boolean {
  const lastSent = rateLimits.get(userId) || 0;
  const now = Date.now();
  
  if (now - lastSent < RATE_LIMIT_MS) {
    return false;
  }
  
  rateLimits.set(userId, now);
  return true;
}

// GET: Get recent chat messages (initial load only)
export const GET: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = locals.runtime.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
    const before = url.searchParams.get('before'); // For pagination

    const filters = [];
    if (before) {
      const beforeDate = new Date(before);
      filters.push({ field: 'createdAt', op: 'LESS_THAN' as const, value: beforeDate });
    }

    const messages = await queryCollection('djLobbyChat', {
      filters: filters.length > 0 ? filters : undefined,
      orderBy: { field: 'createdAt', direction: 'DESCENDING' },
      limit,
      skipCache: true
    });

    // Ensure createdAt is ISO string format and reverse to get chronological order
    const formattedMessages = messages.map(msg => ({
      ...msg,
      createdAt: msg.createdAt instanceof Date ? msg.createdAt.toISOString() : (msg.createdAt || new Date().toISOString())
    })).reverse();

    return successResponse({ messages: formattedMessages }, 200, { headers: { 'Cache-Control': 'no-cache' } });

  } catch (error: unknown) {
    log.error('[dj-lobby/chat] GET Error:', error);
    return ApiErrors.serverError('Failed to get messages');
  }
};

// POST: Send a chat message
export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: chat messages - 30 per minute per IP (global protection)
  const clientId = getClientId(request);
  const globalRateLimit = checkGlobalRateLimit(`dj-lobby-chat:${clientId}`, RateLimiters.chat);
  if (!globalRateLimit.allowed) {
    return rateLimitResponse(globalRateLimit.retryAfter!);
  }

  // Initialize Firebase for Cloudflare runtime
  const env = locals.runtime.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const rawBody = await request.json();
    const parseResult = LobbyChatSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { userId, name, text, avatar } = parseResult.data;

    // SECURITY: Verify the requesting user owns this userId
    const authHeader = request.headers.get('Authorization');
    const idToken = authHeader?.replace('Bearer ', '') || undefined;
    const { verifyUserToken } = await import('../../../lib/firebase-rest');

    if (!idToken) {
      return ApiErrors.unauthorized('Authentication required');
    }
    const tokenUserId = await verifyUserToken(idToken);
    if (!tokenUserId || tokenUserId !== userId) {
      return ApiErrors.forbidden('You can only send messages as yourself');
    }

    // Rate limiting
    if (!checkRateLimit(userId)) {
      return ApiErrors.tooManyRequests('Slow down! Wait a moment before sending another message.');
    }

    // Basic content validation
    const cleanText = text.trim().substring(0, 500); // Max 500 chars

    // Check for spam patterns
    const lowerText = cleanText.toLowerCase();
    const spamPatterns = ['http://', 'https://', '.com/', '.co.uk/', 'discord.gg'];
    if (spamPatterns.some(pattern => lowerText.includes(pattern))) {
      return ApiErrors.badRequest('Links are not allowed in chat');
    }

    const now = new Date();

    const chatMessage = {
      odamiMa: userId,
      name: name || 'DJ',
      text: cleanText,
      avatar: avatar || null,
      createdAt: now
    };

    // Save to Firebase (for history)
    const docResult = await addDocument('djLobbyChat', chatMessage);

    // Broadcast via Pusher (real-time delivery)
    await triggerPusher('dj-lobby', 'chat-message', {
      id: docResult.id,
      ...chatMessage,
      createdAt: now.toISOString()
    }, env);

    return successResponse({ message: {
        id: docResult.id,
        ...chatMessage,
        createdAt: now.toISOString()
      } });

  } catch (error: unknown) {
    log.error('[dj-lobby/chat] POST Error:', error);
    return ApiErrors.serverError('Failed to send message');
  }
};

// DELETE: Delete a message (admin/owner only)
export const DELETE: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = locals.runtime.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });

  try {
    // SECURITY: Verify user identity via Firebase token
    const { userId: authUserId, error: authError } = await verifyRequestUser(request);
    if (!authUserId || authError) {
      return ApiErrors.unauthorized('Authentication required');
    }

    const url = new URL(request.url);
    const messageId = url.searchParams.get('messageId');

    if (!messageId) {
      return ApiErrors.badRequest('Message ID required');
    }

    // Get the message to verify ownership
    const messageData = await getDocument('djLobbyChat', messageId);

    if (!messageData) {
      return ApiErrors.notFound('Message not found');
    }

    // SECURITY: Use verified userId for authorization check
    const userIsAdmin = await isAdmin(authUserId);
    const isOwner = messageData?.odamiMa === authUserId;

    if (!userIsAdmin && !isOwner) {
      return ApiErrors.forbidden('Not authorized to delete this message');
    }

    // Delete the message
    await deleteDocument('djLobbyChat', messageId);

    // Broadcast deletion via Pusher
    await triggerPusher('dj-lobby', 'chat-deleted', {
      id: messageId,
      deletedBy: userId,
      timestamp: new Date().toISOString()
    }, env);

    return successResponse({ message: 'Message deleted' });

  } catch (error: unknown) {
    log.error('[dj-lobby/chat] DELETE Error:', error);
    return ApiErrors.serverError('Failed to delete message');
  }
};
