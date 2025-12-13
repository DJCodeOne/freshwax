// src/pages/api/dj-lobby/chat.ts
// DJ Lobby chat - Pusher-based real-time (no Firebase onSnapshot)
// Messages stored in Firebase, delivered via Pusher

import type { APIRoute } from 'astro';
import { getDocument, deleteDocument, queryCollection, addDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { createHmac, createHash } from 'crypto';

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
  const env = (locals as any)?.runtime?.env;
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

    return new Response(JSON.stringify({
      success: true,
      messages: formattedMessages
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      }
    });

  } catch (error) {
    console.error('[dj-lobby/chat] GET Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to get messages'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// POST: Send a chat message
export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const data = await request.json();
    const { userId, name, text, avatar } = data;

    if (!userId || !text?.trim()) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User ID and message text required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Rate limiting
    if (!checkRateLimit(userId)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Slow down! Wait a moment before sending another message.'
      }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    }

    // Basic content validation
    const cleanText = text.trim().substring(0, 500); // Max 500 chars

    // Check for spam patterns
    const lowerText = cleanText.toLowerCase();
    const spamPatterns = ['http://', 'https://', '.com/', '.co.uk/', 'discord.gg'];
    if (spamPatterns.some(pattern => lowerText.includes(pattern))) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Links are not allowed in chat'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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
    });

    return new Response(JSON.stringify({
      success: true,
      message: {
        id: docResult.id,
        ...chatMessage,
        createdAt: now.toISOString()
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[dj-lobby/chat] POST Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to send message'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// DELETE: Delete a message (admin/owner only)
export const DELETE: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const url = new URL(request.url);
    const messageId = url.searchParams.get('messageId');
    const userId = url.searchParams.get('userId');
    const isAdmin = url.searchParams.get('isAdmin') === 'true';

    if (!messageId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Message ID required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Get the message to verify ownership
    const messageData = await getDocument('djLobbyChat', messageId);

    if (!messageData) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Message not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // Check authorization
    if (!isAdmin && messageData?.odamiMa !== userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Not authorized to delete this message'
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    // Delete the message
    await deleteDocument('djLobbyChat', messageId);

    // Broadcast deletion via Pusher
    await triggerPusher('dj-lobby', 'chat-deleted', {
      id: messageId,
      deletedBy: userId,
      timestamp: new Date().toISOString()
    });

    return new Response(JSON.stringify({
      success: true,
      message: 'Message deleted'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[dj-lobby/chat] DELETE Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to delete message'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
