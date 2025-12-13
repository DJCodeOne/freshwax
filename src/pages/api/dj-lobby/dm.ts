// src/pages/api/dj-lobby/dm.ts
// DJ Direct Messages - Pusher-based real-time (no Firebase onSnapshot)
// Private messages between DJs in the lobby

import type { APIRoute } from 'astro';
import { getDocument, setDocument, deleteDocument, queryCollection, addDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
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

// Helper to create consistent DM channel ID
function getDmChannelId(uid1: string, uid2: string): string {
  return [uid1, uid2].sort().join('_');
}

// GET: Get DM conversation
export const GET: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');
    const targetId = url.searchParams.get('targetId');
    const type = url.searchParams.get('type'); // 'messages' or 'conversations'
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);

    if (!userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User ID required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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

      return new Response(JSON.stringify({
        success: true,
        conversations: formattedConversations
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Get messages for specific conversation
    if (!targetId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Target ID required for messages'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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

    return new Response(JSON.stringify({
      success: true,
      messages: formattedMessages,
      channelId
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[dj-lobby/dm] GET Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to get messages'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// POST: Send a DM
export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const data = await request.json();
    const { senderId, senderName, receiverId, receiverName, text, senderAvatar } = data;

    if (!senderId || !receiverId || !text?.trim()) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Sender ID, receiver ID, and message text required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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

    // Send to both sender and receiver's private channels
    await Promise.all([
      triggerPusher(`private-dj-${senderId}`, 'dm-message', pusherMessage),
      triggerPusher(`private-dj-${receiverId}`, 'dm-message', pusherMessage)
    ]);

    // Also send notification to receiver if they're not in the conversation
    await triggerPusher(`private-dj-${receiverId}`, 'dm-notification', {
      senderId,
      senderName: senderName || 'DJ',
      preview: cleanText.substring(0, 50),
      timestamp: now.toISOString()
    });

    return new Response(JSON.stringify({
      success: true,
      message: {
        id: messageResult.id,
        ...messageData,
        createdAt: now.toISOString()
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[dj-lobby/dm] POST Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to send message'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// DELETE: Delete conversation or clear messages
export const DELETE: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
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
      return new Response(JSON.stringify({
        success: false,
        error: 'User ID and target ID required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const channelId = getDmChannelId(userId, targetId);

    // Get all messages in the conversation
    const messages = await queryCollection(`djDirectMessages/${channelId}/messages`, {
      skipCache: true
    });

    // Delete all messages
    await Promise.all(messages.map(msg => deleteDocument(`djDirectMessages/${channelId}/messages`, msg.id)));

    // Delete the channel document
    await deleteDocument('djDirectMessages', channelId);

    // Notify both users that conversation was cleared
    await Promise.all([
      triggerPusher(`private-dj-${userId}`, 'dm-cleared', { channelId, targetId }),
      triggerPusher(`private-dj-${targetId}`, 'dm-cleared', { channelId, targetId: userId })
    ]);

    return new Response(JSON.stringify({
      success: true,
      message: 'Conversation deleted'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[dj-lobby/dm] DELETE Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to delete conversation'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
