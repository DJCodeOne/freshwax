// src/pages/api/stream/end.ts
// Admin endpoint to forcefully end a stream
// Checks both livestreamSlots (current system) and livestreams (legacy) collections
import type { APIRoute } from 'astro';
import { getDocument, updateDocument, queryCollection, clearCache } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { broadcastLiveStatus } from '../../../lib/pusher';
import { invalidateStatusCache } from '../livestream/status';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { createLogger, ApiErrors } from '../../../lib/api-utils';

const log = createLogger('[stream-end]');

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;

  // Rate limit
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`stream-end:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  try {
    const data = await request.json();
    const { streamId, djId, reason } = data;

    // SECURITY: Require admin authentication
    const authError = await requireAdminAuth(request, locals, data);
    if (authError) return authError;

    if (!streamId) {
      return ApiErrors.badRequest('Stream ID is required');
    }

    const now = new Date().toISOString();
    let ended = false;
    let streamData: Record<string, unknown> | null = null;

    // Try livestreamSlots first (current system)
    const slotDoc = await getDocument('livestreamSlots', streamId);
    if (slotDoc && (slotDoc.status === 'live' || slotDoc.status === 'scheduled' || slotDoc.status === 'in_lobby')) {
      streamData = slotDoc;
      await updateDocument('livestreamSlots', streamId, {
        status: 'completed',
        endedAt: now,
        updatedAt: now,
        endReason: reason || 'admin_ended'
      });
      ended = true;

      // Clear caches so status endpoint returns fresh data
      clearCache('livestreamSlots');
      await invalidateStatusCache();

      // Broadcast via Pusher for instant client updates
      try {
        await broadcastLiveStatus('stream-ended', {
          djId: slotDoc.djId,
          djName: slotDoc.djName,
          slotId: streamId,
          reason: reason || 'admin_ended'
        }, env);
      } catch (pusherErr: unknown) {
        log.warn('Pusher broadcast failed (non-critical):', pusherErr);
      }

      log.info(`Admin ended slot ${streamId} (DJ: ${slotDoc.djName || djId})`);
    }

    // Also check legacy livestreams collection
    const streamDoc = await getDocument('livestreams', streamId);
    if (streamDoc) {
      streamData = streamData || streamDoc;
      await updateDocument('livestreams', streamId, {
        status: 'offline',
        isLive: false,
        endedAt: now,
        endReason: reason || 'admin_ended',
        updatedAt: now
      });
      ended = true;

      log.info(`Admin ended legacy stream ${streamId} (DJ: ${streamDoc.djName || djId})`);
    }

    if (!ended) {
      return ApiErrors.notFound('Stream not found in any collection');
    }

    // Mark all viewer sessions as ended
    try {
      const sessions = await queryCollection('livestream-viewers', {
        filters: [
          { field: 'streamId', op: 'EQUAL', value: streamId },
          { field: 'isActive', op: 'EQUAL', value: true }
        ]
      });

      await Promise.all(
        sessions.map(session =>
          updateDocument('livestream-viewers', session.id, {
            isActive: false,
            leftAt: now
          })
        )
      );
    } catch (e: unknown) {
      // Viewers collection might not exist
      log.warn('Could not update viewer sessions:', e);
    }

    return successResponse({ message: 'Stream ended successfully' });

  } catch (error: unknown) {
    log.error('Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
};
