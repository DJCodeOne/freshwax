// src/pages/api/livestream/manage.ts
// Start, stop, and update live streams

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { generateStreamKey, buildRtmpUrl, buildHlsUrl, RED5_CONFIG } from '../../../lib/red5';

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
    const { action, djId, streamId, ...streamData } = data;
    
    if (!djId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'DJ ID is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    const now = new Date();
    const nowISO = now.toISOString();
    
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
        
        // Generate stream ID and key
        const streamRef = db.collection('livestreams').doc();
        const defaultEndTime = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2 hours default
        
        // Use provided stream key or generate new one
        const streamKey = streamData.streamKey || generateStreamKey(
          djId, 
          streamRef.id, 
          now, 
          defaultEndTime
        );
        
        // Build URLs
        const rtmpUrl = buildRtmpUrl(streamKey);
        const hlsUrl = streamData.hlsUrl || buildHlsUrl(streamKey);
        
        const newStream = {
          djId,
          djName: streamData.djName || artistData.artistName || artistData.name,
          djAvatar: artistData.avatarUrl || null,
          title: streamData.title || `${artistData.artistName || 'DJ'} Live`,
          description: streamData.description || '',
          genre: streamData.genre || 'Jungle / D&B',
          
          // Streaming config
          streamType: streamData.streamType || 'video',
          streamSource: 'red5',
          streamKey,
          rtmpUrl,
          hlsUrl,
          
          // Legacy fields (for compatibility)
          audioStreamUrl: streamData.audioStreamUrl || null,
          videoStreamUrl: streamData.videoStreamUrl || null,
          twitchChannel: streamData.twitchChannel || null,
          
          status: 'live',
          isLive: true,
          startedAt: nowISO,
          endedAt: null,
          
          peakViewers: 0,
          currentViewers: 0,
          totalViews: 0,
          totalLikes: 0,
          averageRating: 0,
          ratingCount: 0,
          
          coverImage: streamData.coverImage || artistData.avatarUrl || null,
          
          createdAt: nowISO,
          updatedAt: nowISO
        };
        
        await streamRef.set(newStream);
        
        console.log('[livestream/manage] Stream started:', streamRef.id, 'by DJ:', djId);
        
        return new Response(JSON.stringify({
          success: true,
          streamId: streamRef.id,
          streamKey,
          rtmpUrl,
          hlsUrl,
          serverUrl: RED5_CONFIG.server.rtmpUrl,
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
          endedAt: nowISO,
          updatedAt: nowISO
        });
        
        // Mark all viewer sessions as ended
        const sessions = await db.collection('livestream-viewers')
          .where('streamId', '==', streamId)
          .where('isActive', '==', true)
          .get();
        
        const batch = db.batch();
        sessions.docs.forEach(doc => {
          batch.update(doc.ref, { isActive: false, leftAt: nowISO });
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
        const updates: any = { updatedAt: nowISO };
        
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
          streamType: streamData.streamType || 'video',
          streamSource: 'red5',
          
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
          
          createdAt: nowISO,
          updatedAt: nowISO
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
      
      case 'dj_ready': {
        // Mark DJ as ready in their slot
        const { slotId } = data;
        if (!slotId) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Slot ID is required'
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        
        const slotRef = db.collection('livestreamSlots').doc(slotId);
        const slotDoc = await slotRef.get();
        
        if (!slotDoc.exists) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Slot not found'
          }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
        
        const slotData = slotDoc.data()!;
        
        // Verify this is the DJ's slot
        if (slotData.djId !== djId) {
          return new Response(JSON.stringify({
            success: false,
            error: 'This is not your slot'
          }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }
        
        // Mark as ready
        await slotRef.update({
          djReady: true,
          djReadyAt: nowISO,
          updatedAt: nowISO
        });
        
        console.log(`[manage] DJ ${djId} marked ready for slot ${slotId}`);
        
        return new Response(JSON.stringify({
          success: true,
          message: 'DJ marked as ready'
        }), { 
          status: 200, 
          headers: { 'Content-Type': 'application/json' } 
        });
      }
      
      case 'slot_expired': {
        // Mark slot as expired/available for takeover
        const { slotId } = data;
        if (!slotId) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Slot ID is required'
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        
        const slotRef = db.collection('livestreamSlots').doc(slotId);
        const slotDoc = await slotRef.get();
        
        if (!slotDoc.exists) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Slot not found'
          }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
        
        const slotData = slotDoc.data()!;
        
        // Only the original DJ or an admin can mark their slot as expired
        // (This gets called when the 3-minute grace period ends)
        if (slotData.djId !== djId) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Cannot expire another DJ\'s slot'
          }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }
        
        // Mark as available for takeover
        await slotRef.update({
          status: 'available',
          expiredAt: nowISO,
          originalDjId: slotData.djId,
          originalDjName: slotData.djName,
          djId: null, // Clear DJ assignment
          djName: 'Available',
          djReady: false,
          updatedAt: nowISO
        });
        
        console.log(`[manage] Slot ${slotId} marked as available for takeover`);
        
        return new Response(JSON.stringify({
          success: true,
          message: 'Slot marked as available'
        }), { 
          status: 200, 
          headers: { 'Content-Type': 'application/json' } 
        });
      }
      
      case 'claim_slot': {
        // Claim an available slot (first come first served)
        
        // Find available slots
        const availableSlots = await db.collection('livestreamSlots')
          .where('status', '==', 'available')
          .limit(1)
          .get();
        
        if (availableSlots.empty) {
          return new Response(JSON.stringify({
            success: false,
            error: 'No slots available'
          }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
        
        const availableSlot = availableSlots.docs[0];
        const slotRef = availableSlot.ref;
        const slotData = availableSlot.data();
        
        // Check if DJ is approved
        const artistDoc = await db.collection('artists').doc(djId).get();
        if (!artistDoc.exists || !artistDoc.data()?.approved) {
          return new Response(JSON.stringify({
            success: false,
            error: 'You must be an approved DJ to claim slots'
          }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }
        
        const artistData = artistDoc.data()!;
        
        // Use transaction to prevent race conditions
        try {
          await db.runTransaction(async (transaction) => {
            const freshSlot = await transaction.get(slotRef);
            
            // Double-check still available
            if (!freshSlot.exists || freshSlot.data()?.status !== 'available') {
              throw new Error('Slot no longer available');
            }
            
            // Claim the slot
            transaction.update(slotRef, {
              status: 'in_lobby',
              djId: djId,
              djName: artistData.artistName || artistData.displayName || 'DJ',
              djAvatar: artistData.avatarUrl || null,
              djReady: true, // Already ready since they're claiming
              djReadyAt: nowISO,
              claimedAt: nowISO,
              claimedFromExpiry: true,
              updatedAt: nowISO
            });
          });
          
          console.log(`[manage] DJ ${djId} claimed slot ${availableSlot.id}`);
          
          return new Response(JSON.stringify({
            success: true,
            slotId: availableSlot.id,
            streamKey: slotData.streamKey,
            message: 'Slot claimed successfully'
          }), { 
            status: 200, 
            headers: { 'Content-Type': 'application/json' } 
          });
          
        } catch (err) {
          console.error('[manage] Failed to claim slot:', err);
          return new Response(JSON.stringify({
            success: false,
            error: 'Slot was claimed by another DJ'
          }), { status: 409, headers: { 'Content-Type': 'application/json' } });
        }
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
