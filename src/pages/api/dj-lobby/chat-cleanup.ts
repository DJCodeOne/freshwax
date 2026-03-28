// src/pages/api/dj-lobby/chat-cleanup.ts
// DJ Lobby chat cleanup - check and clean up old chat messages, record stream end times
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, setDocument, deleteDocument, queryCollection, verifyUserToken } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const ChatCleanupSchema = z.object({
  action: z.enum(['check-and-cleanup', 'record-stream-end']),
  isCurrentlyLive: z.boolean().optional(),
});

const log = createLogger('dj-lobby/chat-cleanup');

export const prerender = false;

// Check if user has DJ or admin role
async function isDjOrAdmin(userId: string): Promise<boolean> {
  try {
    // Check admin collection
    const adminDoc = await getDocument('admins', userId);
    if (adminDoc) return true;

    // Check user roles
    const userDoc = await getDocument('users', userId);
    if (userDoc?.roles?.dj || userDoc?.roles?.djEligible || userDoc?.roles?.artist) return true;

    return false;
  } catch (e: unknown) {
    return false;
  }
}

// POST: Check and cleanup chat, or record stream end
export const POST: APIRoute = async ({ request }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`dj-lobby-chat-cleanup:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    // Verify authentication
    const authHeader = request.headers.get('Authorization');
    const idToken = authHeader?.replace('Bearer ', '') || undefined;
    if (!idToken) {
      return ApiErrors.unauthorized('Authentication required');
    }
    const userId = await verifyUserToken(idToken);
    if (!userId) {
      return ApiErrors.forbidden('Invalid token');
    }

    // Only DJs and admins can manage chat cleanup
    if (!(await isDjOrAdmin(userId))) {
      return ApiErrors.forbidden('DJ or admin access required');
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch (_e: unknown) {
      return ApiErrors.badRequest('Invalid JSON body');
    }

    const parsed = ChatCleanupSchema.safeParse(rawBody);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request body');
    }
    const { action, isCurrentlyLive: isLive } = parsed.data;

    switch (action) {
      case 'check-and-cleanup': {
        // Check if chat should be cleaned up (2 hours since last stream ended)
        const settings = await getDocument('djLobbySettings', 'chatCleanup');

        if (!settings) {
          return successResponse({ cleaned: false,
            reason: 'no-settings' });
        }

        const lastStreamEndTime = settings.lastStreamEndTime
          ? new Date(settings.lastStreamEndTime).getTime()
          : 0;
        const now = Date.now();
        const twoHoursMs = 2 * 60 * 60 * 1000;
        const isCurrentlyLive = isLive || false;

        if (isCurrentlyLive || lastStreamEndTime === 0 || (now - lastStreamEndTime) <= twoHoursMs) {
          return successResponse({ cleaned: false,
            reason: isCurrentlyLive ? 'currently-live' : 'too-recent' });
        }

        // Delete all DJ lobby chat messages
        const chatMessages = await queryCollection('djLobbyChat', { limit: 500 });
        const deletePromises = chatMessages.map(msg =>
          deleteDocument('djLobbyChat', msg.id)
        );
        const results = await Promise.allSettled(deletePromises);
        const failures = results.filter(r => r.status === 'rejected');
        if (failures.length > 0) {
          log.error('Some operations failed', { failures: failures.map(f => f.reason?.message || String(f.reason)) });
        }

        // Reset the lastStreamEndTime so we don't keep deleting
        await setDocument('djLobbySettings', 'chatCleanup', {
          lastStreamEndTime: null,
          lastCleanup: new Date().toISOString()
        });

        return successResponse({ cleaned: true,
          messagesDeleted: chatMessages.length - failures.length });
      }

      case 'record-stream-end': {
        // Record that a stream has ended (for timed cleanup)
        await setDocument('djLobbySettings', 'chatCleanup', {
          lastStreamEndTime: new Date().toISOString()
        });

        return successResponse({ message: 'Stream end recorded' });
      }

      default:
        return ApiErrors.badRequest('Invalid action. Use check-and-cleanup or record-stream-end');
    }

  } catch (error: unknown) {
    log.error('Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
};
