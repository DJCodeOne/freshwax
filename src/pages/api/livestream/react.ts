// src/pages/api/livestream/react.ts
// Live stream reactions - likes, ratings, viewer tracking, emoji broadcasts
// Uses Pusher for real-time emoji delivery
// Uses Web Crypto API for Cloudflare Workers compatibility

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, deleteDocument, queryCollection, addDocument, atomicIncrement, verifyRequestUser } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../../lib/rate-limit';
import { triggerPusher } from '../../../lib/pusher';
import { ApiErrors, createLogger, successResponse, jsonResponse, errorResponse} from '../../../lib/api-utils';

const log = createLogger('livestream-react');
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
    } catch (e: unknown) {
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

        // Atomically increment total likes counter first
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
          }
        }

        // Single combined broadcast: reaction data + updated like count
        const reactionData = {
          type: emojiType || 'emoji',
          emoji: emoji || '❤️',
          userName: userName || 'Someone',
          userId: userId || null,
          sessionId: sessionId || null,
          totalLikes: totalLikes || undefined,
          timestamp: now
        };

        const pusherSuccess = await triggerPusher(channel, 'reaction', reactionData, env);

        if (!pusherSuccess) {
          return ApiErrors.serverError('Failed to broadcast reaction via Pusher');
        }

        return successResponse({ message: 'Reaction broadcast',
          channel,
          pusherSuccess,
          totalLikes });
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
        
        return successResponse({ message: 'Star reaction broadcast' });
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
            log.info('[react] Stream not found for like counter, skipping increment');
          }
        }

        // Broadcast updated like count to all viewers (only if we have a count)
        if (totalLikes > 0) {
          await triggerPusher(`stream-${streamId}`, 'like-update', {
            totalLikes,
            timestamp: now
          }, env);
        }

        return successResponse({ liked: true,
          totalLikes,
          message: 'Stream liked!' });
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
        
        return successResponse({ rating,
          averageRating: newAverage,
          ratingCount: newCount });
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

        // Viewer count broadcasts are handled by listeners.ts — no Pusher here
        return successResponse({ sessionId: viewerSession.sessionId,
          currentViewers,
          peakViewers });
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
            const { collection: leaveCollection } = await getStreamDocument(streamId);
            await atomicIncrement(leaveCollection, streamId, { currentViewers: -1 });

            // Viewer count broadcasts are handled by listeners.ts — no Pusher here
          }
        }

        return successResponse({});
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
        
        return successResponse({ currentViewers: streamData?.currentViewers || 0,
          totalLikes: streamData?.totalLikes || 0 });
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
        const shoutoutSuccess = await triggerPusher(shoutoutChannel, 'shoutout', {
          name: userName || 'Someone',
          message: message,
          timestamp: now
        }, env);

        if (!shoutoutSuccess) {
          return ApiErrors.serverError('Failed to broadcast shoutout via Pusher');
        }

        return successResponse({ message: 'Shoutout broadcast' });
      }
      
      default:
        return ApiErrors.badRequest('Invalid action');
    }
    
  } catch (error: unknown) {
    log.error('[livestream/react] Error:', error);
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
    
    return successResponse({ hasLiked,
      userRating });
    
  } catch (error: unknown) {
    log.error('[livestream/react] GET Error:', error);
    return ApiErrors.serverError('Failed to get reactions');
  }
};
