// src/pages/api/livestream/manage.ts
// Start, stop, and update live streams

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, setDocument, queryCollection, addDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { generateStreamKey, buildRtmpUrl, buildHlsUrl, RED5_CONFIG } from '../../../lib/red5';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('livestream/manage');

const livestreamManageSchema = z.object({
  action: z.enum(['start', 'stop', 'update', 'schedule', 'dj_ready', 'slot_expired', 'claim_slot']),
  djId: z.string().min(1),
  streamId: z.string().optional(),
}).passthrough();

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: stream management - 30 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`livestream-manage:${clientId}`, RateLimiters.write);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;

  try {
    // SECURITY: Verify user identity - djId must match authenticated user
    const { userId: authenticatedUserId, error: authError } = await verifyRequestUser(request);

    if (authError || !authenticatedUserId) {
      return ApiErrors.unauthorized('Authentication required');
    }

    const data = await request.json();

    const parsed = livestreamManageSchema.safeParse(data);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { action, djId, streamId, ...streamData } = parsed.data;

    // SECURITY: Verify the authenticated user matches the claimed djId
    if (authenticatedUserId !== djId) {
      return ApiErrors.forbidden('You can only manage your own streams');
    }
    
    const now = new Date();
    const nowISO = now.toISOString();
    
    switch (action) {
      case 'start': {
        // Check if DJ is approved
        const artistDoc = await getDocument('artists', djId);
        if (!artistDoc) {
          return ApiErrors.notFound('DJ not found');
        }

        const artistData = artistDoc;
        if (!artistData.approved) {
          return ApiErrors.forbidden('You must be an approved DJ to go live');
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
          return ApiErrors.badRequest('You already have a live stream running');
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

        return successResponse({ streamId: streamId,
          streamKey,
          rtmpUrl,
          hlsUrl,
          serverUrl: RED5_CONFIG.server.rtmpUrl,
          stream: { id: streamId, ...newStream } });
      }
      
      case 'stop': {
        if (!streamId) {
          return ApiErrors.badRequest('Stream ID is required');
        }

        const stream = await getDocument('livestreams', streamId);

        if (!stream) {
          return ApiErrors.notFound('Stream not found');
        }

        // Verify ownership
        if (stream.djId !== djId) {
          return ApiErrors.forbidden('You can only stop your own stream');
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
        
        return successResponse({ message: 'Stream ended successfully' });
      }
      
      case 'update': {
        if (!streamId) {
          return ApiErrors.badRequest('Stream ID is required');
        }

        const stream = await getDocument('livestreams', streamId);

        if (!stream) {
          return ApiErrors.notFound('Stream not found');
        }

        // Update allowed fields
        const updates: Record<string, unknown> = { updatedAt: nowISO };

        if (streamData.title) updates.title = streamData.title;
        if (streamData.description !== undefined) updates.description = streamData.description;
        if (streamData.genre) updates.genre = streamData.genre;
        if (streamData.audioStreamUrl) updates.audioStreamUrl = streamData.audioStreamUrl;
        if (streamData.videoStreamUrl) updates.videoStreamUrl = streamData.videoStreamUrl;
        if (streamData.twitchChannel) updates.twitchChannel = streamData.twitchChannel;
        if (streamData.coverImage) updates.coverImage = streamData.coverImage;

        await updateDocument('livestreams', streamId, updates);
        
        return successResponse({ message: 'Stream updated' });
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

        return successResponse({ streamId: newStreamId,
          message: 'Stream scheduled' });
      }
      
      case 'dj_ready': {
        // Mark DJ as ready in their slot
        const { slotId } = data;
        if (!slotId) {
          return ApiErrors.badRequest('Slot ID is required');
        }
        
        const slotData = await getDocument('livestreamSlots', slotId);

        if (!slotData) {
          return ApiErrors.notFound('Slot not found');
        }

        // Verify this is the DJ's slot
        if (slotData.djId !== djId) {
          return ApiErrors.forbidden('This is not your slot');
        }

        // Mark as ready
        await updateDocument('livestreamSlots', slotId, {
          djReady: true,
          djReadyAt: nowISO,
          updatedAt: nowISO
        });
        
        return successResponse({ message: 'DJ marked as ready' });
      }
      
      case 'slot_expired': {
        // Mark slot as expired/available for takeover
        const { slotId } = data;
        if (!slotId) {
          return ApiErrors.badRequest('Slot ID is required');
        }
        
        const slotData = await getDocument('livestreamSlots', slotId);

        if (!slotData) {
          return ApiErrors.notFound('Slot not found');
        }

        // Only the original DJ or an admin can mark their slot as expired
        // (This gets called when the 3-minute grace period ends)
        if (slotData.djId !== djId) {
          return ApiErrors.forbidden('Cannot expire another DJ slot');
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
        
        return successResponse({ message: 'Slot marked as available' });
      }
      
      case 'claim_slot': {
        // Claim an available slot (first come first served)

        // Find available slots
        const availableSlots = await queryCollection('livestreamSlots', {
          filters: [{ field: 'status', op: 'EQUAL', value: 'available' }],
          limit: 1
        });

        if (availableSlots.length === 0) {
          return ApiErrors.notFound('No slots available');
        }

        const availableSlot = availableSlots[0];
        const slotId = availableSlot.id;
        const slotData = availableSlot;

        // Check if DJ is approved
        const artistDoc = await getDocument('artists', djId);
        if (!artistDoc || !artistDoc.approved) {
          return ApiErrors.forbidden('You must be an approved DJ to claim slots');
        }

        const artistData = artistDoc;

        // Note: REST API doesn't support transactions, so there's a small race condition risk
        // Double-check still available
        const freshSlot = await getDocument('livestreamSlots', slotId);
        if (!freshSlot || freshSlot.status !== 'available') {
          return ApiErrors.conflict('Slot no longer available');
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

        return successResponse({ slotId: slotId,
          streamKey: slotData.streamKey,
          message: 'Slot claimed successfully' });
      }
      
      default:
        return ApiErrors.badRequest('Invalid action');
    }
    
  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to manage stream');
  }
};
