// src/pages/api/livestream/manage.ts
// Start, stop, and update live streams

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, deleteDocument, queryCollection, addDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { generateStreamKey, buildRtmpUrl, buildHlsUrl, RED5_CONFIG } from '../../../lib/red5';

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

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
        const artistDoc = await getDocument('artists', djId);
        if (!artistDoc) {
          return new Response(JSON.stringify({
            success: false,
            error: 'DJ not found'
          }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }

        const artistData = artistDoc;
        if (!artistData.approved) {
          return new Response(JSON.stringify({
            success: false,
            error: 'You must be an approved DJ to go live'
          }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }

        // Check if DJ already has a live stream
        const existingLive = await queryCollection('livestreams', {
          filters: [
            { field: 'djId', op: 'EQUAL', value: djId },
            { field: 'isLive', op: 'EQUAL', value: true }
          ],
          limit: 1
        });

        if (existingLive.length > 0) {
          return new Response(JSON.stringify({
            success: false,
            error: 'You already have a live stream running',
            existingStreamId: existingLive[0].id
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }

        // Generate stream ID - we'll create it manually
        const streamId = `stream_${Date.now()}_${djId.substring(0, 8)}`;
        const defaultEndTime = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2 hours default
        
        // Use provided stream key or generate new one
        const streamKey = streamData.streamKey || generateStreamKey(
          djId,
          streamId,
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
        
        await setDocument('livestreams', streamId, newStream);

        console.log('[livestream/manage] Stream started:', streamId, 'by DJ:', djId);

        return new Response(JSON.stringify({
          success: true,
          streamId: streamId,
          streamKey,
          rtmpUrl,
          hlsUrl,
          serverUrl: RED5_CONFIG.server.rtmpUrl,
          stream: { id: streamId, ...newStream }
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

        const stream = await getDocument('livestreams', streamId);

        if (!stream) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Stream not found'
          }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }

        // Verify ownership
        if (stream.djId !== djId) {
          return new Response(JSON.stringify({
            success: false,
            error: 'You can only stop your own stream'
          }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }

        // End the stream
        await updateDocument('livestreams', streamId, {
          status: 'offline',
          isLive: false,
          endedAt: nowISO,
          updatedAt: nowISO
        });

        // Mark all viewer sessions as ended
        const sessions = await queryCollection('livestream-viewers', {
          filters: [
            { field: 'streamId', op: 'EQUAL', value: streamId },
            { field: 'isActive', op: 'EQUAL', value: true }
          ]
        });

        // Update all sessions (note: batch operations not available in REST API)
        await Promise.all(sessions.map(session =>
          updateDocument('livestream-viewers', session.id, { isActive: false, leftAt: nowISO })
        ));
        
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

        const stream = await getDocument('livestreams', streamId);

        if (!stream) {
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

        await updateDocument('livestreams', streamId, updates);
        
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
        
        const { id: newStreamId } = await addDocument('livestreams', newStream);

        return new Response(JSON.stringify({
          success: true,
          streamId: newStreamId,
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
        
        const slotData = await getDocument('livestreamSlots', slotId);

        if (!slotData) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Slot not found'
          }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }

        // Verify this is the DJ's slot
        if (slotData.djId !== djId) {
          return new Response(JSON.stringify({
            success: false,
            error: 'This is not your slot'
          }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }

        // Mark as ready
        await updateDocument('livestreamSlots', slotId, {
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
        
        const slotData = await getDocument('livestreamSlots', slotId);

        if (!slotData) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Slot not found'
          }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }

        // Only the original DJ or an admin can mark their slot as expired
        // (This gets called when the 3-minute grace period ends)
        if (slotData.djId !== djId) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Cannot expire another DJ\'s slot'
          }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }

        // Mark as available for takeover
        await updateDocument('livestreamSlots', slotId, {
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
        const availableSlots = await queryCollection('livestreamSlots', {
          filters: [{ field: 'status', op: 'EQUAL', value: 'available' }],
          limit: 1
        });

        if (availableSlots.length === 0) {
          return new Response(JSON.stringify({
            success: false,
            error: 'No slots available'
          }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }

        const availableSlot = availableSlots[0];
        const slotId = availableSlot.id;
        const slotData = availableSlot;

        // Check if DJ is approved
        const artistDoc = await getDocument('artists', djId);
        if (!artistDoc || !artistDoc.approved) {
          return new Response(JSON.stringify({
            success: false,
            error: 'You must be an approved DJ to claim slots'
          }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }

        const artistData = artistDoc;

        // Note: REST API doesn't support transactions, so there's a small race condition risk
        // Double-check still available
        const freshSlot = await getDocument('livestreamSlots', slotId);
        if (!freshSlot || freshSlot.status !== 'available') {
          return new Response(JSON.stringify({
            success: false,
            error: 'Slot no longer available'
          }), { status: 409, headers: { 'Content-Type': 'application/json' } });
        }

        // Claim the slot
        await updateDocument('livestreamSlots', slotId, {
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

        console.log(`[manage] DJ ${djId} claimed slot ${slotId}`);

        return new Response(JSON.stringify({
          success: true,
          slotId: slotId,
          streamKey: slotData.streamKey,
          message: 'Slot claimed successfully'
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
