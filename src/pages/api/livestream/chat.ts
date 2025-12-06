// src/pages/api/livestream/chat.ts
// Live stream chat - send messages, get recent messages

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

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

// Get recent chat messages
export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const streamId = url.searchParams.get('streamId');
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const after = url.searchParams.get('after'); // For pagination
    
    if (!streamId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Stream ID is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    let query = db.collection('livestream-chat')
      .where('streamId', '==', streamId)
      .where('isModerated', '==', false)
      .orderBy('createdAt', 'desc')
      .limit(limit);
    
    if (after) {
      query = query.startAfter(after);
    }
    
    const messagesSnap = await query.get();
    
    const messages = messagesSnap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    })).reverse(); // Reverse to get chronological order
    
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
export const POST: APIRoute = async ({ request }) => {
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
    const streamDoc = await db.collection('livestreams').doc(streamId).get();
    if (!streamDoc.exists || !streamDoc.data()?.isLive) {
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
    const recentMessages = await db.collection('livestream-chat')
      .where('streamId', '==', streamId)
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    
    if (!recentMessages.empty) {
      const lastMessage = recentMessages.docs[0].data();
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
    
    const messageRef = await db.collection('livestream-chat').add(chatMessage);
    
    return new Response(JSON.stringify({
      success: true,
      message: {
        id: messageRef.id,
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
export const DELETE: APIRoute = async ({ request }) => {
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
    await db.collection('livestream-chat').doc(messageId).update({
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
