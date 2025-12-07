// src/pages/api/livestream/react.ts
// Live stream reactions - likes, ratings, viewer tracking

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

export const POST: APIRoute = async ({ request }) => {
  try {
    const data = await request.json();
    const { action, streamId, userId, rating, sessionId } = data;
    
    if (!streamId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Stream ID is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    const now = new Date().toISOString();
    const streamRef = db.collection('livestreams').doc(streamId);
    
    switch (action) {
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
