// src/pages/api/livestream/chat-cleanup.ts
// API to schedule and execute chat cleanup after DJ session ends
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, setDocument, deleteDocument, queryCollection } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { createLogger, ApiErrors, successResponse } from '../../../lib/api-utils';

const chatCleanupSchema = z.object({
  streamId: z.string().min(1),
  action: z.enum(['schedule', 'cancel', 'execute']),
});

const log = createLogger('[chat-cleanup]');

export const prerender = false;

// Safety limits
const MAX_MESSAGES_PER_BATCH = 500; // Max messages to delete in one operation
const MAX_PENDING_JOBS = 50; // Max pending cleanup jobs to process at once

// POST - Schedule chat cleanup for a stream
export const POST: APIRoute = async ({ request, locals }) => {
  // Admin authentication required
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  // Rate limit: chat cleanup operations - 20 per hour
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`chat-cleanup:${clientId}`, RateLimiters.adminDelete);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }  try {
    const data = await request.json();
    const parseResult = chatCleanupSchema.safeParse(data);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request data');
    }
    const { streamId, action } = parseResult.data;
    
    if (action === 'schedule') {
      // Schedule cleanup for 30 minutes from now
      const cleanupTime = new Date(Date.now() + 30 * 60 * 1000);

      await setDocument('chatCleanupSchedule', streamId, {
        streamId,
        scheduledAt: new Date().toISOString(),
        cleanupAt: cleanupTime.toISOString(),
        status: 'pending'
      });

      return successResponse({ message: 'Chat cleanup scheduled',
        cleanupAt: cleanupTime.toISOString() });
    }

    if (action === 'cancel') {
      // Cancel scheduled cleanup (if DJ comes back)
      await deleteDocument('chatCleanupSchedule', streamId);

      return successResponse({ message: 'Chat cleanup cancelled' });
    }

    if (action === 'execute') {
      // Execute cleanup now
      const deleted = await deleteStreamChat(streamId);

      // Mark cleanup as complete
      await updateDocument('chatCleanupSchedule', streamId, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        messagesDeleted: deleted
      });

      return successResponse({ message: 'Chat cleared',
        messagesDeleted: deleted });
    }
    
    return ApiErrors.badRequest('Invalid action');
  } catch (error: unknown) {
    log.error('Chat cleanup error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
};

// GET - Check and execute pending cleanups (call this periodically)
export const GET: APIRoute = async ({ request, locals }) => {
  // Admin authentication required
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  // Rate limit: chat cleanup check - 60 per hour
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`chat-cleanup-check:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }  try {
    const url = new URL(request.url);
    const executeNow = url.searchParams.get('execute') === 'true';

    // Find pending cleanups that are past their scheduled time (with limit)
    const now = new Date();
    const allPending = await queryCollection('chatCleanupSchedule', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'pending' }],
      limit: MAX_PENDING_JOBS
    });

    const pending = allPending.filter((job: Record<string, unknown>) => {
      const cleanupAt = new Date(job.cleanupAt);
      return cleanupAt <= now;
    });
    
    if (!executeNow) {
      return successResponse({ pendingCleanups: pending.length,
        jobs: pending.map((j: Record<string, unknown>) => ({
          streamId: j.streamId,
          cleanupAt: j.cleanupAt
        })) });
    }

    // Execute all pending cleanups
    const settled = await Promise.allSettled(
      pending.map(async (job: Record<string, unknown>) => {
        try {
          const deleted = await deleteStreamChat(job.streamId);

          await updateDocument('chatCleanupSchedule', job.id, {
            status: 'completed',
            completedAt: new Date().toISOString(),
            messagesDeleted: deleted
          });

          return { streamId: job.streamId, success: true, deleted };
        } catch (error: unknown) {
          await updateDocument('chatCleanupSchedule', job.id, {
            status: 'failed',
            error: 'Internal error'
          });

          return { streamId: job.streamId, success: false, error: 'Internal error' };
        }
      })
    );

    const failures = settled.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      log.error('Some operations failed', { failures: failures.map(f => f.reason?.message || String(f.reason)) });
    }

    const results = settled
      .filter((r): r is PromiseFulfilledResult<{ streamId: string; success: boolean; deleted?: number; error?: string }> => r.status === 'fulfilled')
      .map(r => r.value);

    return successResponse({ executed: results.length,
      results });
  } catch (error: unknown) {
    log.error('Chat cleanup check error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
};

// Delete all chat messages for a stream (with safety limit)
async function deleteStreamChat(streamId: string): Promise<number> {
  let totalDeleted = 0;
  let hasMore = true;

  // Delete in batches to prevent runaway operations
  while (hasMore) {
    const chatMessages = await queryCollection('livestream-chat', {
      filters: [{ field: 'streamId', op: 'EQUAL', value: streamId }],
      limit: MAX_MESSAGES_PER_BATCH
    });

    if (chatMessages.length === 0) {
      hasMore = false;
      break;
    }

    // Delete batch (note: REST API doesn't support batch operations)
    const deleteResults = await Promise.allSettled(chatMessages.map(msg =>
      deleteDocument('livestream-chat', msg.id)
    ));
    const deleteFailures = deleteResults.filter(r => r.status === 'rejected');
    if (deleteFailures.length > 0) {
      log.error('Some message deletes failed', { failures: deleteFailures.map(f => f.reason?.message || String(f.reason)) });
    }

    totalDeleted += chatMessages.length - deleteFailures.length;
    log.info(`Deleted batch of ${chatMessages.length} messages for stream ${streamId}`);

    // If we got less than the limit, we're done
    if (chatMessages.length < MAX_MESSAGES_PER_BATCH) {
      hasMore = false;
    }
  }

  log.info(`Total deleted: ${totalDeleted} messages for stream ${streamId}`);
  return totalDeleted;
}
