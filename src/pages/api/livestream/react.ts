// src/pages/api/livestream/react.ts
// Live stream reactions - likes, ratings, viewer tracking, emoji broadcasts
// Uses Pusher for real-time emoji delivery
// Uses Web Crypto API for Cloudflare Workers compatibility

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, deleteDocument, queryCollection, addDocument, atomicIncrement, verifyRequestUser } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../../lib/rate-limit';
import { triggerPusher } from '../../../lib/pusher';
import { ApiErrors, createLogger } from '../../../lib/api-utils';

const logger = createLogger('livestream-react');
import { z } from 'zod';

const ReactSchema = z.object({
  action: z.enum(['emoji', 'star', 'like', 'rate', 'join', 'leave', 'heartbeat', 'shoutout']),
  streamId: z.string().min(1).max(200),
  userId: z.string().max(200).nullish(),
  userName: z.string().max(200).nullish(),
  rating: z.number().int().min(1).max(5).nullish(),
  sessionId: z.string().max(200).nullish(),
  emoji: z.string().max(50).nullish(),
  emojiType: z.string().max(50).nullish(),
  message: z.string().max(30).nullish(),
}).passthrough();

// Helper to get stream document from either collection (livestreamSlots or livestreams)
async function getStreamDocument(streamId: string) {
  // Try livestreamSlots first (new system)
  let doc = await getDocument('livestreamSlots', streamId);
  if (doc) return { doc, collection: 'livestreamSlots' };

  // Fall back to livestreams (legacy)
  doc = await getDocument('livestreams', streamId);
  if (doc) return { doc, collection: 'livestreams' };

  return { doc: null, collection: 'livestreamSlots' };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals?.runtime?.env;
  const clientId = getClientId(request);

  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return ApiErrors.badRequest('Invalid JSON body');
    }

    const parseResult = ReactSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const data = parseResult.data;
    const { action, streamId, userId: bodyUserId, userName, rating, sessionId, emoji, emojiType } = data;

    // SECURITY: Use verified userId when auth header is present
    // For write actions (like, rate, join, shoutout), require verified auth
    // For broadcast-only actions (emoji, star), allow unauthenticated with rate limiting
    const { userId: verifiedUserId } = await verifyRequestUser(request).catch(() => ({ userId: null }));
    const isWriteAction = ['like', 'rate', 'join', 'leave', 'heartbeat', 'shoutout'].includes(action);
    const userId = verifiedUserId || (isWriteAction ? null : bodyUserId);

    // Rate limit emoji/star reactions (30 per minute per client)
    if (action === 'emoji' || action === 'star') {
      const rateCheck = checkRateLimit(`react-emoji:${clientId}`, {
        maxRequests: 30,
        windowMs: 60 * 1000,
        blockDurationMs: 60 * 1000
      });
      if (!rateCheck.allowed) {
        return rateLimitResponse(rateCheck.retryAfter!);
      }
    }

    // Rate limit join/heartbeat (10 per minute - prevents rapid reconnects)
    if (action === 'join' || action === 'heartbeat') {
      const rateCheck = checkRateLimit(`react-presence:${clientId}:${streamId}`, {
        maxRequests: 10,
        windowMs: 60 * 1000
      });
      if (!rateCheck.allowed) {
        return rateLimitResponse(rateCheck.retryAfter!);
      }
    }

    const now = new Date().toISOString();

    switch (action) {
      case 'emoji': {
        // Broadcast emoji reaction to all viewers via Pusher and increment counter
        const { sessionId } = data;
        const channel = `stream-${streamId}`;
        const reactionData = {
          type: emojiType || 'emoji',
          emoji: emoji || '❤️',
          userName: userName || 'Someone',
          userId: userId || null,
          sessionId: sessionId || null,
          timestamp: now
        };

        logger.info('[react.ts] Broadcasting emoji to channel:', channel, 'data:', reactionData);
        const pusherSuccess = await triggerPusher(channel, 'reaction', reactionData, env);
        logger.info('[react.ts] Pusher broadcast result:', pusherSuccess);

        // Atomically increment total likes counter
        let totalLikes = 0;
        try {
          const result = await atomicIncrement('livestreamSlots', streamId, { totalLikes: 1 });
          totalLikes = result.newValues.totalLikes ?? 0;
        } catch (e: unknown) {
          try {
            const result = await atomicIncrement('livestreams', streamId, { totalLikes: 1 });
            totalLikes = result.newValues.totalLikes ?? 0;
          } catch (e2: unknown) {
            // Stream doesn't exist in either collection (playlist mode) - that's OK
            logger.info('[react] Stream not found for reaction counter, skipping increment');
          }
        }

        // Broadcast updated like count to all viewers
        if (totalLikes > 0) {
          await triggerPusher(channel, 'like-update', {
            totalLikes,
            timestamp: now
          }, env);
        }

        if (!pusherSuccess) {
          return ApiErrors.serverError('Failed to broadcast reaction via Pusher');
        }

        return new Response(JSON.stringify({
          success: true,
          message: 'Reaction broadcast',
          channel,
          pusherSuccess,
          totalLikes
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
        }, env);
        
        return new Response(JSON.stringify({
          success: true,
          message: 'Star reaction broadcast'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      case 'like': {
        if (!userId) {
          return ApiErrors.unauthorized('Must be logged in to like');
        }

        // Always add a like (no toggle - reactions accumulate)
        await addDocument('livestream-reactions', {
          streamId,
          userId,
          type: 'like',
          createdAt: now
        });

        // Atomically increment total likes - try livestreamSlots first, fall back to livestreams
        // If neither exists (playlist mode), just skip the counter update
        let totalLikes = 0;
        try {
          const result = await atomicIncrement('livestreamSlots', streamId, { totalLikes: 1 });
          totalLikes = result.newValues.totalLikes ?? 0;
        } catch (e: unknown) {
          try {
            // Fall back to livestreams collection
            const result = await atomicIncrement('livestreams', streamId, { totalLikes: 1 });
            totalLikes = result.newValues.totalLikes ?? 0;
          } catch (e2: unknown) {
            // Stream doesn't exist in either collection (playlist mode) - that's OK
            logger.info('[react] Stream not found for like counter, skipping increment');
          }
        }

        // Broadcast updated like count to all viewers (only if we have a count)
        if (totalLikes > 0) {
          await triggerPusher(`stream-${streamId}`, 'like-update', {
            totalLikes,
            timestamp: now
          }, env);
        }

        return new Response(JSON.stringify({
          success: true,
          liked: true,
          totalLikes,
          message: 'Stream liked!'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      case 'rate': {
        if (!userId) {
          return ApiErrors.unauthorized('Must be logged in to rate');
        }
        
        if (!rating || rating < 1 || rating > 5) {
          return ApiErrors.badRequest('Rating must be between 1 and 5');
        }
        
        // Check for existing rating
        const existingRatings = await queryCollection('livestream-reactions', {
          filters: [
            { field: 'streamId', op: 'EQUAL', value: streamId },
            { field: 'userId', op: 'EQUAL', value: userId },
            { field: 'type', op: 'EQUAL', value: 'rating' }
          ],
          limit: 1
        });

        const { doc: streamData, collection: rateCollection } = await getStreamDocument(streamId);
        if (!streamData) {
          return ApiErrors.notFound('Stream not found');
        }

        let newAverage: number;
        let newCount: number;

        if (existingRatings.length > 0) {
          // Update existing rating
          const existingRating = existingRatings[0];
          const oldRating = existingRating.rating;
          await updateDocument('livestream-reactions', existingRating.id, { rating, updatedAt: now });

          // Recalculate average
          const totalRating = (streamData.averageRating * streamData.ratingCount) - oldRating + rating;
          newCount = streamData.ratingCount;
          newAverage = totalRating / newCount;
        } else {
          // Add new rating
          await addDocument('livestream-reactions', {
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

        await updateDocument(rateCollection, streamId, {
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

        await addDocument('livestream-viewers', viewerSession);

        // Update viewer counts - use correct collection
        const { doc: streamDoc, collection } = await getStreamDocument(streamId);
        const currentViewers = (streamDoc?.currentViewers || 0) + 1;
        const peakViewers = Math.max(streamDoc?.peakViewers || 0, currentViewers);

        await updateDocument(collection, streamId, {
          currentViewers,
          peakViewers
        });

        // Atomically increment total views
        await atomicIncrement(collection, streamId, { totalViews: 1 });

        // Broadcast viewer count update to all viewers
        await triggerPusher(`stream-${streamId}`, 'viewer-update', {
          currentViewers,
          peakViewers,
          timestamp: now
        }, env);

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
          const sessions = await queryCollection('livestream-viewers', {
            filters: [
              { field: 'streamId', op: 'EQUAL', value: streamId },
              { field: 'sessionId', op: 'EQUAL', value: sessionId },
              { field: 'isActive', op: 'EQUAL', value: true }
            ],
            limit: 1
          });

          if (sessions.length > 0) {
            await updateDocument('livestream-viewers', sessions[0].id, {
              isActive: false,
              leftAt: now
            });

            // Atomically decrement viewer count in correct collection
            const { doc: leaveDoc, collection: leaveCollection } = await getStreamDocument(streamId);
            await atomicIncrement(leaveCollection, streamId, { currentViewers: -1 });

            // Broadcast updated viewer count
            const newViewerCount = Math.max(0, (leaveDoc?.currentViewers || 1) - 1);
            await triggerPusher(`stream-${streamId}`, 'viewer-update', {
              currentViewers: newViewerCount,
              timestamp: now
            }, env);
          }
        }

        return new Response(JSON.stringify({
          success: true
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      case 'heartbeat': {
        // Keep viewer session alive
        if (sessionId) {
          const sessions = await queryCollection('livestream-viewers', {
            filters: [
              { field: 'streamId', op: 'EQUAL', value: streamId },
              { field: 'sessionId', op: 'EQUAL', value: sessionId },
              { field: 'isActive', op: 'EQUAL', value: true }
            ],
            limit: 1
          });

          if (sessions.length > 0) {
            await updateDocument('livestream-viewers', sessions[0].id, {
              lastHeartbeat: now
            });
          }
        }

        // Return current stats from correct collection
        const { doc: streamData } = await getStreamDocument(streamId);
        
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
          return ApiErrors.unauthorized('Must be logged in to shoutout');
        }

        if (!message || message.length > 30) {
          return ApiErrors.badRequest('Shoutout must be 1-30 characters');
        }

        const shoutoutChannel = `stream-${streamId}`;
        logger.info('[react.ts] Broadcasting shoutout to channel:', shoutoutChannel);
        const shoutoutSuccess = await triggerPusher(shoutoutChannel, 'shoutout', {
          name: userName || 'Someone',
          message: message,
          timestamp: now
        }, env);
        logger.info('[react.ts] Shoutout broadcast result:', shoutoutSuccess);

        if (!shoutoutSuccess) {
          return ApiErrors.serverError('Failed to broadcast shoutout via Pusher');
        }

        return new Response(JSON.stringify({
          success: true,
          message: 'Shoutout broadcast'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      default:
        return ApiErrors.badRequest('Invalid action');
    }
    
  } catch (error: unknown) {
    logger.error('[livestream/react] Error:', error);
    return ApiErrors.serverError('Failed to process reaction');
  }
};

// Get user's reactions for a stream
export const GET: APIRoute = async ({ request, locals }) => {  try {
    const url = new URL(request.url);
    const streamId = url.searchParams.get('streamId');
    const userId = url.searchParams.get('userId');

    if (!streamId || !userId) {
      return ApiErrors.badRequest('Stream ID and User ID required');
    }

    // SECURITY: Verify the user is querying their own reactions
    const { userId: verifiedUid } = await verifyRequestUser(request).catch(() => ({ userId: null }));
    if (!verifiedUid || verifiedUid !== userId) {
      return ApiErrors.unauthorized('Authentication required');
    }
    
    const reactions = await queryCollection('livestream-reactions', {
      filters: [
        { field: 'streamId', op: 'EQUAL', value: streamId },
        { field: 'userId', op: 'EQUAL', value: userId }
      ]
    });

    let hasLiked = false;
    let userRating = null;

    reactions.forEach(data => {
      if (data.type === 'like') hasLiked = true;
      if (data.type === 'rating') userRating = data.rating;
    });
    
    return new Response(JSON.stringify({
      success: true,
      hasLiked,
      userRating
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    
  } catch (error: unknown) {
    logger.error('[livestream/react] GET Error:', error);
    return ApiErrors.serverError('Failed to get reactions');
  }
};
