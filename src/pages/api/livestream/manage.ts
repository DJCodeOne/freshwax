// src/pages/api/livestream/manage.ts
// Start, stop, and update live streams

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

// Generate stream key for DJ
function generateStreamKey(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let key = 'fw_live_';
  for (let i = 0; i < 24; i++) {
    key += chars[Math.floor(Math.random() * chars.length)];
  }
  return key;
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const data = await request.json();
    const { action, djId, streamId, ...streamData } = data;
    
    if (!djId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'DJ ID is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    const now = new Date().toISOString();
    
    switch (action) {
      case 'start': {
        // Check if DJ is approved
        const artistDoc = await db.collection('artists').doc(djId).get();
        if (!artistDoc.exists) {
          return new Response(JSON.stringify({
            success: false,
            error: 'DJ not found'
          }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
        
        const artistData = artistDoc.data()!;
        if (!artistData.approved) {
          return new Response(JSON.stringify({
            success: false,
            error: 'You must be an approved DJ to go live'
          }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }
        
        // Check if DJ already has a live stream
        const existingLive = await db.collection('livestreams')
          .where('djId', '==', djId)
          .where('isLive', '==', true)
          .limit(1)
          .get();
        
        if (!existingLive.empty) {
          return new Response(JSON.stringify({
            success: false,
            error: 'You already have a live stream running',
            existingStreamId: existingLive.docs[0].id
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        
        // Create new stream
        const streamKey = streamData.streamKey || generateStreamKey();
        
        // Build HLS URL for Red5 streams
        let hlsUrl = streamData.hlsUrl || null;
        if (streamData.streamSource === 'red5' && streamKey) {
          // Default Red5 HLS path
          hlsUrl = hlsUrl || `https://stream.freshwax.co.uk/hls/${streamKey}/index.m3u8`;
        }
        
        const newStream = {
          djId,
          djName: streamData.djName || artistData.artistName || artistData.name,
          djAvatar: artistData.avatarUrl || null,
          title: streamData.title || `${artistData.artistName || 'DJ'} Live`,
          description: streamData.description || '',
          genre: streamData.genre || 'Jungle / D&B',
          
          streamType: streamData.streamType || 'red5',
          streamSource: streamData.streamSource || 'red5',
          audioStreamUrl: streamData.audioStreamUrl || null,
          videoStreamUrl: streamData.videoStreamUrl || null,
          hlsUrl: hlsUrl,
          twitchChannel: streamData.twitchChannel || null,
          
          streamKey, // Private key for DJ
          
          status: 'live',
          isLive: true,
          startedAt: now,
          endedAt: null,
          
          peakViewers: 0,
          currentViewers: 0,
          totalViews: 0,
          totalLikes: 0,
          averageRating: 0,
          ratingCount: 0,
          
          coverImage: streamData.coverImage || artistData.avatarUrl || null,
          
          createdAt: now,
          updatedAt: now
        };
        
        const streamRef = await db.collection('livestreams').add(newStream);
        
        console.log('[livestream/manage] Stream started:', streamRef.id, 'by DJ:', djId, 'source:', streamData.streamSource);
        
        return new Response(JSON.stringify({
          success: true,
          streamId: streamRef.id,
          streamKey,
          stream: { id: streamRef.id, ...newStream }
        }), { 
          status: 200, 
          headers: { 'Content-Type': 'application/json' } 
        });
      }
      
      case 'stop': {
        if (!streamId) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Stream ID is required'
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        
        const streamRef = db.collection('livestreams').doc(streamId);
        const streamDoc = await streamRef.get();
        
        if (!streamDoc.exists) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Stream not found'
          }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
        
        const stream = streamDoc.data()!;
        
        // Verify ownership
        if (stream.djId !== djId) {
          return new Response(JSON.stringify({
            success: false,
            error: 'You can only stop your own stream'
          }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }
        
        // End the stream
        await streamRef.update({
          status: 'offline',
          isLive: false,
          endedAt: now,
          updatedAt: now
        });
        
        // Mark all viewer sessions as ended
        const sessions = await db.collection('livestream-viewers')
          .where('streamId', '==', streamId)
          .where('isActive', '==', true)
          .get();
        
        const batch = db.batch();
        sessions.docs.forEach(doc => {
          batch.update(doc.ref, { isActive: false, leftAt: now });
        });
        await batch.commit();
        
        console.log('[livestream/manage] Stream stopped:', streamId);
        
        return new Response(JSON.stringify({
          success: true,
          message: 'Stream ended successfully'
        }), { 
          status: 200, 
          headers: { 'Content-Type': 'application/json' } 
        });
      }
      
      case 'update': {
        if (!streamId) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Stream ID is required'
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        
        const streamRef = db.collection('livestreams').doc(streamId);
        const streamDoc = await streamRef.get();
        
        if (!streamDoc.exists) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Stream not found'
          }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
        
        // Update allowed fields
        const updates: any = { updatedAt: now };
        
        if (streamData.title) updates.title = streamData.title;
        if (streamData.description !== undefined) updates.description = streamData.description;
        if (streamData.genre) updates.genre = streamData.genre;
        if (streamData.audioStreamUrl) updates.audioStreamUrl = streamData.audioStreamUrl;
        if (streamData.videoStreamUrl) updates.videoStreamUrl = streamData.videoStreamUrl;
        if (streamData.twitchChannel) updates.twitchChannel = streamData.twitchChannel;
        if (streamData.coverImage) updates.coverImage = streamData.coverImage;
        
        await streamRef.update(updates);
        
        return new Response(JSON.stringify({
          success: true,
          message: 'Stream updated'
        }), { 
          status: 200, 
          headers: { 'Content-Type': 'application/json' } 
        });
      }
      
      case 'schedule': {
        // Schedule a future stream
        const newStream = {
          djId,
          djName: streamData.djName,
          title: streamData.title,
          description: streamData.description || '',
          genre: streamData.genre || 'Jungle / D&B',
          streamType: streamData.streamType || 'audio',
          streamSource: streamData.streamSource || 'icecast',
          
          status: 'scheduled',
          isLive: false,
          scheduledFor: streamData.scheduledFor,
          
          peakViewers: 0,
          currentViewers: 0,
          totalViews: 0,
          totalLikes: 0,
          averageRating: 0,
          ratingCount: 0,
          
          coverImage: streamData.coverImage || null,
          
          createdAt: now,
          updatedAt: now
        };
        
        const streamRef = await db.collection('livestreams').add(newStream);
        
        return new Response(JSON.stringify({
          success: true,
          streamId: streamRef.id,
          message: 'Stream scheduled'
        }), { 
          status: 200, 
          headers: { 'Content-Type': 'application/json' } 
        });
      }
      
      default:
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid action'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
  } catch (error) {
    console.error('[livestream/manage] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to manage stream'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
