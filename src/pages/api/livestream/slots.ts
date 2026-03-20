// src/pages/api/livestream/slots.ts
// DJ livestream schedule - uses Firebase REST API + D1 sync
// Handler dispatchers only — logic extracted to src/lib/livestream-slots/
import type { APIRoute } from 'astro';
import { verifyRequestUser } from '../../../lib/firebase-rest';
import { isAdmin } from '../../../lib/admin';
import { createLogger, ApiErrors, fetchWithTimeout, successResponse } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { updateDocument, getDocument } from '../../../lib/firebase-rest';
import { invalidateStatusCache } from './status';

import { SlotsPostSchema, SlotsDeleteSchema } from '../../../lib/livestream-slots/schemas';
import { initServices, getSettings, invalidateCache, syncSlotStatusToD1 } from '../../../lib/livestream-slots/helpers';
import {
  handleCheckStreamKey,
  handleCurrentLive,
  handleCanGoLiveAfter,
  handleHistory,
  handleSchedule,
} from '../../../lib/livestream-slots/get-actions';
import {
  handleBook,
  handleGoLiveNow,
  handleEarlyStart,
  handleCancel,
  handleEndStream,
  handleHeartbeat,
  handleGetStreamKey,
  handleGenerateKey,
  handleGoLive,
  handleUpdateSlot,
  handleStartRelay,
} from '../../../lib/livestream-slots/post-actions';

const log = createLogger('[livestream-slots]');

// GET: Fetch schedule
export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`livestream-slots-get:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;
  const db = env?.DB; // D1 database binding

  try {
    initServices(locals);
  } catch (initError: unknown) {
    const initErrMsg = initError instanceof Error ? initError.message : String(initError);
    log.error('initServices error:', initErrMsg);
    return ApiErrors.serverError('Failed to initialize services');
  }

  try {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const djId = url.searchParams.get('djId');
    const settings = await getSettings();

    // Check stream key availability
    if (action === 'checkStreamKey' && djId) {
      return handleCheckStreamKey(djId, settings);
    }

    // Current live stream
    if (action === 'currentLive') {
      return handleCurrentLive(db, settings);
    }

    // Can go live after current DJ
    if (action === 'canGoLiveAfter' && djId) {
      return handleCanGoLiveAfter(djId, db, settings);
    }

    // Stream history
    if (action === 'history') {
      return handleHistory();
    }

    // Default: Get schedule
    return handleSchedule(request, db, env, invalidateStatusCache);

  } catch (error: unknown) {
    log.error('GET Error:', error);
    return ApiErrors.serverError('Failed to fetch schedule');
  }
};

// POST: Book, cancel, go live, etc.
export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);

  initServices(locals);
  const env = locals?.runtime?.env;
  const db = env?.DB; // D1 database binding for sync
  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch (e: unknown) {
      return ApiErrors.badRequest('Invalid JSON body');
    }

    const parseResult = SlotsPostSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const data = parseResult.data;
    const { action } = data;

    // Rate limit per action type — heartbeats get their own bucket so they
    // don't starve critical actions like endStream
    const rlKey = action === 'heartbeat'
      ? `slots-heartbeat:${clientId}`
      : `livestream-slots-post:${clientId}`;
    const rateLimitPost = checkRateLimit(rlKey, RateLimiters.standard);
    if (!rateLimitPost.allowed) {
      return rateLimitResponse(rateLimitPost.retryAfter!);
    }
    const now = new Date();
    const nowISO = now.toISOString();

    // Extract auth token from Authorization header (Bearer token)
    const authHeader = request.headers.get('Authorization');
    const idToken = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : data.idToken; // Fall back to body for backwards compatibility

    // Verify authenticated user (header first, body idToken fallback for sendBeacon)
    let authUserId: string | null = null;
    const { userId: headerUserId } = await verifyRequestUser(request);
    if (headerUserId) {
      authUserId = headerUserId;
    } else if (data.idToken) {
      // Fallback: verify body idToken directly (for sendBeacon which can't set headers)
      try {
        const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;
        if (apiKey) {
          const verifyResp = await fetchWithTimeout(
            `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: data.idToken }) },
            10000
          );
          if (verifyResp.ok) {
            const verifyData = await verifyResp.json();
            authUserId = verifyData.users?.[0]?.localId || null;
          }
        }
      } catch (tokenErr: unknown) {
        log.warn('Body idToken verification failed:', tokenErr);
      }
    }
    if (!authUserId) {
      return ApiErrors.unauthorized('Authentication required');
    }

    // Dispatch to action handlers
    if (action === 'book') {
      return handleBook(data, authUserId, idToken, db, now, nowISO);
    }

    if (action === 'go_live_now') {
      return handleGoLiveNow(data, authUserId, idToken, db, env, now, nowISO, invalidateStatusCache);
    }

    if (action === 'early_start') {
      return handleEarlyStart(data, authUserId, idToken, db, now, nowISO);
    }

    if (action === 'cancel') {
      return handleCancel(data, authUserId, idToken, db, nowISO);
    }

    if (action === 'endStream') {
      return handleEndStream(data, authUserId, db, env, now, nowISO, invalidateStatusCache);
    }

    if (action === 'heartbeat') {
      return handleHeartbeat(data, authUserId, db, nowISO);
    }

    if (action === 'getStreamKey') {
      return handleGetStreamKey(data, now);
    }

    if (action === 'generate_key') {
      return handleGenerateKey(data, now);
    }

    if (action === 'go_live') {
      return handleGoLive(data, authUserId, idToken, db, env, now, nowISO, invalidateStatusCache);
    }

    if (action === 'update_slot') {
      return handleUpdateSlot(data, authUserId, idToken, db, env, nowISO);
    }

    if (action === 'start_relay') {
      return handleStartRelay(data, authUserId, idToken, db, env, now, nowISO, invalidateStatusCache);
    }

    return ApiErrors.badRequest('Invalid action');

  } catch (error: unknown) {
    log.error('POST Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return ApiErrors.serverError('Failed to process request');
  }
};

// DELETE: Cancel slot
export const DELETE: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimitDelete = checkRateLimit(`livestream-slots-delete:${clientId}`, RateLimiters.standard);
  if (!rateLimitDelete.allowed) {
    return rateLimitResponse(rateLimitDelete.retryAfter!);
  }

  initServices(locals);

  // Verify authenticated user
  const { userId: authUserId, error: authError } = await verifyRequestUser(request);
  if (!authUserId || authError) {
    return ApiErrors.unauthorized('Authentication required');
  }

  try {
    let rawDeleteBody: unknown;
    try {
      rawDeleteBody = await request.json();
    } catch (e: unknown) {
      return ApiErrors.badRequest('Invalid JSON body');
    }

    const deleteParseResult = SlotsDeleteSchema.safeParse(rawDeleteBody);
    if (!deleteParseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { slotId } = deleteParseResult.data;

    const slot = await getDocument('livestreamSlots', slotId);

    if (!slot) {
      return ApiErrors.notFound('Slot not found');
    }

    // Verify the authenticated user owns the slot OR is admin
    const deleteIsAdmin = await isAdmin(authUserId);
    if (slot.djId !== authUserId && !deleteIsAdmin) {
      return ApiErrors.forbidden('Not authorized');
    }

    const cancelledAt = new Date().toISOString();
    await updateDocument('livestreamSlots', slotId, {
      status: 'cancelled',
      cancelledAt,
      cancelledByAdmin: deleteIsAdmin
    });

    invalidateCache();

    // Sync cancellation to D1 (non-blocking)
    const env = locals.runtime.env;
    const db = env?.DB;
    syncSlotStatusToD1(db, slotId, 'cancelled', { cancelledAt });

    return successResponse({ message: 'Slot cancelled' });

  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error('DELETE Error:', errMsg);
    return ApiErrors.serverError(errMsg || 'Failed to cancel slot');
  }
};
