// src/pages/api/admin/clear-chat.ts
// Admin endpoint to clear chat messages with rate limiting and batch safeguards
import type { APIRoute } from 'astro';
import { queryCollection, deleteDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import {
  checkRateLimit,
  checkBatchLimit,
  getClientId,
  rateLimitResponse,
  RateLimiters,
  BatchLimiters,
  delay
} from '../../../lib/rate-limit';

export const prerender = false;

// Maximum messages to delete in a single request
const MAX_MESSAGES_PER_REQUEST = 500;
const MAX_MESSAGES_PER_HOUR = 2000;
const DELAY_BETWEEN_DELETES_MS = 10; // Small delay to prevent overwhelming Firestore

function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);

  const clientId = getClientId(request);

  // Rate limit: max 5 clear operations per minute
  const rateCheck = checkRateLimit(`clear-chat:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) {
    console.warn(`[Admin] Rate limit exceeded for clear-chat from ${clientId}`);
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  try {
    const body = await request.json().catch(() => ({}));

    // Check admin auth (pass body for adminKey check)
    const authError = requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const { streamId, limit } = body;

    // User can optionally specify a lower limit
    const requestLimit = Math.min(limit || MAX_MESSAGES_PER_REQUEST, MAX_MESSAGES_PER_REQUEST);

    let chatMessages;

    if (streamId) {
      // Clear messages for specific stream (with limit)
      chatMessages = await queryCollection('livestream-chat', {
        filters: [{ field: 'streamId', op: 'EQUAL', value: streamId }],
        limit: requestLimit
      });
    } else {
      // Clear chat messages (with limit to prevent runaway)
      chatMessages = await queryCollection('livestream-chat', {
        limit: requestLimit
      });
    }

    if (!chatMessages || chatMessages.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: 'No messages to clear',
        deleted: 0
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check batch limits
    const batchCheck = checkBatchLimit(`clear-chat:${clientId}`, chatMessages.length, {
      maxItems: MAX_MESSAGES_PER_REQUEST,
      maxTotalPerHour: MAX_MESSAGES_PER_HOUR
    });

    if (!batchCheck.allowed) {
      console.warn(`[Admin] Batch limit exceeded for clear-chat: ${batchCheck.error}`);
      return new Response(JSON.stringify({
        success: false,
        error: batchCheck.error,
        maxAllowed: batchCheck.maxAllowed
      }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log(`[Admin] Starting to delete ${chatMessages.length} chat messages (limit: ${requestLimit})`);

    // Delete messages with small delays to prevent overwhelming Firestore
    let deleted = 0;
    let failed = 0;

    for (const msg of chatMessages) {
      try {
        await deleteDocument('livestream-chat', msg.id);
        deleted++;

        // Small delay every 10 deletes
        if (deleted % 10 === 0 && DELAY_BETWEEN_DELETES_MS > 0) {
          await delay(DELAY_BETWEEN_DELETES_MS);
        }
      } catch (err) {
        console.error(`Failed to delete message ${msg.id}:`, err);
        failed++;

        // Stop if too many failures (something is wrong)
        if (failed > 10) {
          console.error('[Admin] Too many delete failures, stopping');
          break;
        }
      }
    }

    const hasMore = chatMessages.length === requestLimit;

    console.log(`[Admin] Cleared ${deleted} chat messages${streamId ? ` for stream ${streamId}` : ''}, ${failed} failed${hasMore ? ', more remaining' : ''}`);

    return new Response(JSON.stringify({
      success: true,
      message: `Cleared ${deleted} chat messages${hasMore ? '. More messages may remain - run again to continue.' : ''}`,
      deleted,
      failed,
      hasMore
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('Clear chat error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to clear chat'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const GET: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);

  const clientId = getClientId(request);

  // Rate limit GET requests too (prevent enumeration abuse)
  const rateCheck = checkRateLimit(`clear-chat-get:${clientId}`, RateLimiters.standard);
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  // Check admin auth
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  try {
    // Get count of chat messages (limit query to prevent huge reads)
    const chatMessages = await queryCollection('livestream-chat', {
      limit: 1000 // Cap the count query
    });

    const count = chatMessages?.length || 0;
    const hasMore = count === 1000;

    return new Response(JSON.stringify({
      success: true,
      count,
      hasMore,
      message: hasMore ? 'At least 1000 messages (count limited for performance)' : undefined
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('Get chat count error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
