// src/pages/api/livestream/react.ts
// Live stream reactions - likes, ratings, viewer tracking, emoji broadcasts
// Uses Pusher for real-time emoji delivery

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
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

export const POST: APIRoute = async ({ request }) => {
  try {
    const data = await request.json();
    const { action, streamId, userId, userName, rating, sessionId, emoji, emojiType } = data;
    
    if (!streamId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Stream ID is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    const now = new Date().toISOString();
    const streamRef = db.collection('livestreams').doc(streamId);
    
    switch (action) {
      case 'emoji': {
        // Broadcast emoji reaction to all viewers via Pusher
        // No database write needed - just broadcast for real-time display
        await triggerPusher(`stream-${streamId}`, 'reaction', {
          type: emojiType || 'emoji',
          emoji: emoji || '❤️',
          userName: userName || 'Someone',
          userId: userId || null,
          timestamp: now
        });
        
        return new Response(JSON.stringify({
          success: true,
          message: 'Reaction broadcast'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      case 'star': {
        // Broadcast star rating animation to all viewers
        const starCount = rating || 1;
        
        await triggerPusher(`stream-${streamId}`, 'reaction', {
          type: 'star',
          count: starCount,
          userName: userName || 'Someone',
          userId: userId || null,
          timestamp: now
        });
        
        return new Response(JSON.stringify({
          success: true,
          message: 'Star reaction broadcast'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      case 'like': {
        if (!userId) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Must be logged in to like'
          }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        
        // Always add a like (no toggle - reactions accumulate)
        await db.collection('livestream-reactions').add({
          streamId,
          userId,
          type: 'like',
          createdAt: now
        });
        
        // Increment total likes
        await streamRef.update({
          totalLikes: FieldValue.increment(1)
        });
        
        // Get updated total
        const streamDoc = await streamRef.get();
        const totalLikes = streamDoc.data()?.totalLikes || 1;
        
        return new Response(JSON.stringify({
          success: true,
          liked: true,
          totalLikes,
          message: 'Stream liked!'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      case 'rate': {
        if (!userId) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Must be logged in to rate'
          }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        
        if (!rating || rating < 1 || rating > 5) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Rating must be between 1 and 5'
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        
        // Check for existing rating
        const existingRating = await db.collection('livestream-reactions')
          .where('streamId', '==', streamId)
          .where('userId', '==', userId)
          .where('type', '==', 'rating')
          .limit(1)
          .get();
        
        const streamDoc = await streamRef.get();
        const streamData = streamDoc.data()!;
        let newAverage: number;
        let newCount: number;
        
        if (!existingRating.empty) {
          // Update existing rating
          const oldRating = existingRating.docs[0].data().rating;
          await existingRating.docs[0].ref.update({ rating, updatedAt: now });
          
          // Recalculate average
          const totalRating = (streamData.averageRating * streamData.ratingCount) - oldRating + rating;
          newCount = streamData.ratingCount;
          newAverage = totalRating / newCount;
        } else {
          // Add new rating
          await db.collection('livestream-reactions').add({
            streamId,
            userId,
            type: 'rating',
            rating,
            createdAt: now
          });
          
          // Calculate new average
          const totalRating = (streamData.averageRating * streamData.ratingCount) + rating;
          newCount = streamData.ratingCount + 1;
          newAverage = totalRating / newCount;
        }
        
        await streamRef.update({
          averageRating: newAverage,
          ratingCount: newCount
        });
        
        return new Response(JSON.stringify({
          success: true,
          rating,
          averageRating: newAverage,
          ratingCount: newCount
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      case 'join': {
        // Track viewer joining
        const viewerSession = {
          streamId,
          userId: userId || null,
          sessionId: sessionId || `anon_${Date.now()}`,
          joinedAt: now,
          leftAt: null,
          isActive: true
        };
        
        await db.collection('livestream-viewers').add(viewerSession);
        
        // Update viewer counts
        const streamDoc = await streamRef.get();
        const currentViewers = (streamDoc.data()?.currentViewers || 0) + 1;
        const peakViewers = Math.max(streamDoc.data()?.peakViewers || 0, currentViewers);
        
        await streamRef.update({
          currentViewers,
          peakViewers,
          totalViews: FieldValue.increment(1)
        });
        
        return new Response(JSON.stringify({
          success: true,
          sessionId: viewerSession.sessionId,
          currentViewers,
          peakViewers
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      case 'leave': {
        // Track viewer leaving
        if (sessionId) {
          const sessions = await db.collection('livestream-viewers')
            .where('streamId', '==', streamId)
            .where('sessionId', '==', sessionId)
            .where('isActive', '==', true)
            .limit(1)
            .get();
          
          if (!sessions.empty) {
            await sessions.docs[0].ref.update({
              isActive: false,
              leftAt: now
            });
            
            await streamRef.update({
              currentViewers: FieldValue.increment(-1)
            });
          }
        }
        
        return new Response(JSON.stringify({
          success: true
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      case 'heartbeat': {
        // Keep viewer session alive
        if (sessionId) {
          const sessions = await db.collection('livestream-viewers')
            .where('streamId', '==', streamId)
            .where('sessionId', '==', sessionId)
            .where('isActive', '==', true)
            .limit(1)
            .get();
          
          if (!sessions.empty) {
            await sessions.docs[0].ref.update({
              lastHeartbeat: now
            });
          }
        }
        
        // Return current stats
        const streamDoc = await streamRef.get();
        const streamData = streamDoc.data();
        
        return new Response(JSON.stringify({
          success: true,
          currentViewers: streamData?.currentViewers || 0,
          totalLikes: streamData?.totalLikes || 0
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      case 'shoutout': {
        // Broadcast shoutout to all viewers via Pusher
        const { message } = data;
        
        if (!userId) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Must be logged in to shoutout'
          }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        
        if (!message || message.length > 30) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Shoutout must be 1-30 characters'
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        
        await triggerPusher(`stream-${streamId}`, 'shoutout', {
          name: userName || 'Someone',
          message: message,
          timestamp: now
        });
        
        return new Response(JSON.stringify({
          success: true,
          message: 'Shoutout broadcast'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      default:
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid action'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
  } catch (error) {
    console.error('[livestream/react] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to process reaction'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// Get user's reactions for a stream
export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const streamId = url.searchParams.get('streamId');
    const userId = url.searchParams.get('userId');
    
    if (!streamId || !userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Stream ID and User ID required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    const reactions = await db.collection('livestream-reactions')
      .where('streamId', '==', streamId)
      .where('userId', '==', userId)
      .get();
    
    let hasLiked = false;
    let userRating = null;
    
    reactions.docs.forEach(doc => {
      const data = doc.data();
      if (data.type === 'like') hasLiked = true;
      if (data.type === 'rating') userRating = data.rating;
    });
    
    return new Response(JSON.stringify({
      success: true,
      hasLiked,
      userRating
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    
  } catch (error) {
    console.error('[livestream/react] GET Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to get reactions'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
