// src/pages/api/livestream/chat.ts
// Live stream chat - send messages, get recent messages
// Uses Pusher for real-time delivery (reduces Firebase reads)

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, deleteDocument, queryCollection, addDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { createHmac, createHash } from 'crypto';

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

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

// Get recent chat messages (initial load only - no real-time)
export const GET: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  initFirebase(locals);

  try {
    const url = new URL(request.url);
    const streamId = url.searchParams.get('streamId');
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const after = url.searchParams.get('after'); // For pagination
    
    if (!streamId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Stream ID is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Note: firebase-rest doesn't support startAfter, so we'll skip pagination for now
    const messages = await queryCollection('livestream-chat', {
      filters: [
        { field: 'streamId', op: 'EQUAL', value: streamId },
        { field: 'isModerated', op: 'EQUAL', value: false }
      ],
      orderBy: { field: 'createdAt', direction: 'DESCENDING' },
      limit
    });

    // Reverse to get chronological order
    messages.reverse();
    
    return new Response(JSON.stringify({
      success: true,
      messages
    }), { 
      status: 200, 
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      } 
    });
    
  } catch (error) {
    console.error('[livestream/chat] GET Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to get messages'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// Send a chat message
export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  initFirebase(locals);

  try {
    const data = await request.json();
    const { streamId, userId, userName, userAvatar, message, type, giphyUrl, giphyId } = data;
    
    if (!streamId || !userId || !message) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required fields'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Verify stream exists and is live
    const streamDoc = await getDocument('livestreams', streamId);
    if (!streamDoc || !streamDoc.isLive) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Stream is not live'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Basic content moderation (can be expanded)
    const bannedWords = ['spam', 'scam', 'http://', 'https://'];
    const lowerMessage = message.toLowerCase();
    const isSpam = bannedWords.some(word => lowerMessage.includes(word));
    
    if (isSpam && type !== 'giphy') {
      return new Response(JSON.stringify({
        success: false,
        error: 'Message contains prohibited content'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Rate limiting - max 1 message per second per user
    const recentMessages = await queryCollection('livestream-chat', {
      filters: [
        { field: 'streamId', op: 'EQUAL', value: streamId },
        { field: 'userId', op: 'EQUAL', value: userId }
      ],
      orderBy: { field: 'createdAt', direction: 'DESCENDING' },
      limit: 1
    });

    if (recentMessages.length > 0) {
      const lastMessage = recentMessages[0];
      const timeSince = Date.now() - new Date(lastMessage.createdAt).getTime();
      if (timeSince < 1000) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Slow down! Wait a moment before sending another message.'
        }), { status: 429, headers: { 'Content-Type': 'application/json' } });
      }
    }
    
    const now = new Date().toISOString();
    
    const chatMessage = {
      streamId,
      userId,
      userName: userName || 'Anonymous',
      userAvatar: userAvatar || null,
      message: message.substring(0, 500), // Limit message length
      type: type || 'text',
      giphyUrl: giphyUrl || null,
      giphyId: giphyId || null,
      isModerated: false,
      createdAt: now
    };
    
    const { id: messageId } = await addDocument('livestream-chat', chatMessage);
    
    // Trigger Pusher for real-time delivery to all connected clients
    // This replaces Firebase onSnapshot - no more reads per client!
    await triggerPusher(`stream-${streamId}`, 'new-message', {
      id: messageId,
      ...chatMessage
    });

    return new Response(JSON.stringify({
      success: true,
      message: {
        id: messageId,
        ...chatMessage
      }
    }), { 
      status: 200, 
      headers: { 'Content-Type': 'application/json' } 
    });
    
  } catch (error) {
    console.error('[livestream/chat] POST Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to send message'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// Delete a message (for moderation)
export const DELETE: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  initFirebase(locals);

  try {
    const url = new URL(request.url);
    const messageId = url.searchParams.get('messageId');
    const moderatorId = url.searchParams.get('moderatorId');
    
    if (!messageId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Message ID is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Mark as moderated rather than delete
    await updateDocument('livestream-chat', messageId, {
      isModerated: true,
      moderatedBy: moderatorId || 'system',
      moderatedAt: new Date().toISOString()
    });
    
    return new Response(JSON.stringify({
      success: true,
      message: 'Message removed'
    }), { 
      status: 200, 
      headers: { 'Content-Type': 'application/json' } 
    });
    
  } catch (error) {
    console.error('[livestream/chat] DELETE Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to delete message'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
