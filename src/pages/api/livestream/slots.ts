// src/pages/api/livestream/slots.ts
// DJ livestream schedule - uses Firebase REST API + D1 sync
import type { APIRoute } from 'astro';
import { queryCollection, getDocument, setDocument, updateDocument, clearCache, verifyRequestUser } from '../../../lib/firebase-rest';
import { generateStreamKey as generateSecureStreamKey, buildRtmpUrl, buildHlsUrl, initRed5Env } from '../../../lib/red5';
import { broadcastLiveStatus } from '../../../lib/pusher';
import { APPROVED_RELAY_STATIONS } from '../../../lib/relay-stations';
import { initKVCache, kvDelete } from '../../../lib/kv-cache';
import { d1UpsertSlot, d1UpdateSlotStatus, d1DeleteSlot, d1GetLiveSlots, d1GetScheduledSlots } from '../../../lib/d1-catalog';
import { invalidateStatusCache } from './status';
import { isAdmin } from '../../../lib/admin';
import { acquireCronLock, releaseCronLock } from '../../../lib/cron-lock';
import { createLogger, ApiErrors, fetchWithTimeout, successResponse, jsonResponse, errorResponse} from '../../../lib/api-utils';

const log = createLogger('[livestream-slots]');
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { z } from 'zod';

const SlotsPostSchema = z.object({
  action: z.string().min(1).max(50),
  idToken: z.string().max(5000).nullish(),
  djId: z.string().max(200).nullish(),
  djName: z.string().max(200).nullish(),
  djAvatar: z.string().max(2000).nullish(),
  startTime: z.string().max(100).nullish(),
  duration: z.number().int().min(1).max(1440).nullish(),
  title: z.string().max(500).nullish(),
  genre: z.string().max(200).nullish(),
  description: z.string().max(5000).nullish(),
  slotId: z.string().max(200).nullish(),
  streamKey: z.string().max(500).nullish(),
  twitchUsername: z.string().max(200).nullish(),
  twitchStreamKey: z.string().max(500).nullish(),
  broadcastMode: z.string().max(50).nullish(),
  relayUrl: z.string().max(2000).nullish(),
  stationName: z.string().max(200).nullish(),
}).passthrough();

const SlotsDeleteSchema = z.object({
  slotId: z.string().min(1).max(200),
}).passthrough();

// Helper to initialize services
function initServices(locals: App.Locals) {
  const env = locals?.runtime?.env;

  const firebaseProjectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
  const firebaseApiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

  const red5RtmpUrl = env?.RED5_RTMP_URL || import.meta.env.RED5_RTMP_URL;
  const red5HlsUrl = env?.RED5_HLS_URL || import.meta.env.RED5_HLS_URL;
  const red5Secret = env?.RED5_SIGNING_SECRET || import.meta.env.RED5_SIGNING_SECRET;

  initRed5Env({
    RED5_RTMP_URL: red5RtmpUrl,
    RED5_HLS_URL: red5HlsUrl,
    RED5_SIGNING_SECRET: red5Secret,
  });

  // Initialize KV cache for invalidation
  initKVCache(env);
}

// Helper to sync slot to D1 (non-blocking, fire-and-forget)
async function syncSlotToD1(db: unknown, slotId: string, slotData: Record<string, unknown>): Promise<void> {
  if (!db) return;
  try {
    await d1UpsertSlot(db, slotId, slotData);
  } catch (e: unknown) {
    log.error('[D1] Error syncing slot (non-critical):', e);
  }
}

// Helper to update slot status in D1 (non-blocking)
async function syncSlotStatusToD1(db: unknown, slotId: string, status: string, extraData?: Record<string, unknown>): Promise<void> {
  if (!db) return;
  try {
    await d1UpdateSlotStatus(db, slotId, status, extraData);
  } catch (e: unknown) {
    log.error('[D1] Error updating slot status (non-critical):', e);
  }
}

const SLOT_DURATIONS = [30, 45, 60, 120, 180, 240];
const MAX_BOOKING_DAYS = 30;

// SECURITY: Sanitize slot data to remove sensitive fields from public responses
function sanitizeSlot(slot: Record<string, unknown>): Record<string, unknown> {
  if (!slot) return slot;
  const { streamKey, twitchStreamKey, rtmpUrl, ...safeSlot } = slot;
  return safeSlot;
}

function sanitizeSlots(slots: Record<string, unknown>[]): Record<string, unknown>[] {
  return slots.map(sanitizeSlot);
}

// Server-side DJ eligibility check — mirrors check-dj-eligibility.ts logic
const REQUIRED_LIKES = 10;
async function checkDjEligible(djId: string): Promise<{ eligible: boolean; reason?: string }> {
  try {
    // Admin bypass
    if (await isAdmin(djId)) return { eligible: true };

    // Check moderation status
    const moderation = await getDocument('djModeration', djId);
    if (moderation?.status === 'banned') return { eligible: false, reason: 'Your account has been suspended from streaming' };
    if (moderation?.status === 'hold') return { eligible: false, reason: 'Your streaming access is temporarily on hold' };

    // Check admin bypass collections
    const bypass = await getDocument('djLobbyBypass', djId);
    if (bypass) return { eligible: true };

    const userData = await getDocument('users', djId);
    if (userData?.['go-liveBypassed'] === true) return { eligible: true };

    // Must have at least 1 mix with 10+ likes
    const mixes = await queryCollection('dj-mixes', {
      filters: [{ field: 'userId', op: 'EQUAL', value: djId }]
    });
    if (mixes.length === 0) return { eligible: false, reason: 'You need to upload at least one DJ mix before you can go live' };

    const qualifying = mixes.filter((m: Record<string, unknown>) => ((m.likeCount as number) || (m.likes as number) || 0) >= REQUIRED_LIKES);
    if (qualifying.length === 0) return { eligible: false, reason: `Your mixes need at least ${REQUIRED_LIKES} likes to go live` };

    return { eligible: true };
  } catch (e: unknown) {
    log.warn('Eligibility check failed, allowing:', e);
    return { eligible: true }; // Fail open to not block DJs on transient errors
  }
}

const DEFAULT_SETTINGS = {
  defaultDailyHours: 2,
  defaultWeeklySlots: 2,
  streamKeyRevealMinutes: 15,
  gracePeriodMinutes: 3,
  sessionEndCountdown: 10,
  allowGoLiveNow: true,
  allowGoLiveAfter: true,
  allowTakeover: true
};

// Use secure stream key generation from red5.ts
function generateStreamKey(djId: string, slotId: string, startTime: Date, endTime: Date): string {
  return generateSecureStreamKey(djId, slotId, startTime, endTime);
}

// Server cache
const serverCache = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_TTL = 5000;

function getFromCache(key: string): unknown | null {
  const entry = serverCache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) return entry.data;
  if (entry) serverCache.delete(key);
  return null;
}

function setCache(key: string, data: unknown): void {
  if (serverCache.size > 100) {
    const oldest = serverCache.keys().next().value;
    if (oldest) serverCache.delete(oldest);
  }
  serverCache.set(key, { data, timestamp: Date.now() });
}

function invalidateCache(): void {
  serverCache.clear();
}

async function getSettings() {
  try {
    const doc = await getDocument('system', 'admin-settings');
    return { ...DEFAULT_SETTINGS, ...(doc?.livestream || {}) };
  } catch (e: unknown) {
    return DEFAULT_SETTINGS;
  }
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

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
    const startDate = url.searchParams.get('start') || new Date().toISOString();
    const endDate = url.searchParams.get('end') || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const djId = url.searchParams.get('djId');
    const forceRefresh = url.searchParams.get('_t');
    const action = url.searchParams.get('action');

    const settings = await getSettings();

    // Check stream key availability
    if (action === 'checkStreamKey' && djId) {
      const now = new Date();
      const slots = await queryCollection('livestreamSlots', {
        filters: [{ field: 'djId', op: 'EQUAL', value: djId }],
        skipCache: true
      });

      const activeSlots = slots.filter(s => ['scheduled', 'in_lobby'].includes(s.status));
      activeSlots.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

      let keyAvailable = false;
      let slotInfo = null;
      let timeUntilKey = null;
      let streamKey = null;

      for (const slot of activeSlots) {
        const slotStart = new Date(slot.startTime);
        const graceEnd = new Date(slotStart.getTime() + settings.gracePeriodMinutes * 60 * 1000);
        const keyRevealStart = new Date(slotStart.getTime() - settings.streamKeyRevealMinutes * 60 * 1000);

        if (now >= keyRevealStart && now <= graceEnd) {
          keyAvailable = true;
          streamKey = slot.streamKey;
          slotInfo = { id: slot.id, startTime: slot.startTime, endTime: slot.endTime, title: slot.title, status: slot.status };
          break;
        } else if (slotStart > now) {
          timeUntilKey = Math.max(0, keyRevealStart.getTime() - now.getTime());
          slotInfo = { id: slot.id, startTime: slot.startTime, endTime: slot.endTime, title: slot.title, status: slot.status };
          break;
        }
      }

      return successResponse({ keyAvailable,
        streamKey: keyAvailable ? streamKey : null,
        slotInfo,
        timeUntilKey,
        settings: {
          streamKeyRevealMinutes: settings.streamKeyRevealMinutes,
          gracePeriodMinutes: settings.gracePeriodMinutes,
          sessionEndCountdown: settings.sessionEndCountdown
        } }, 200, { headers: { 'Cache-Control': 'no-store' } });
    }

    // Current live stream - use D1 first (FREE reads)
    if (action === 'currentLive') {
      // Try D1 first
      let slots = db ? await d1GetLiveSlots(db) : [];

      // Fallback to Firebase if D1 empty
      if (slots.length === 0) {
        slots = await queryCollection('livestreamSlots', {
          filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
          limit: 1,
          skipCache: true
        });
      }

      if (slots.length === 0) {
        return successResponse({ isLive: false, currentStream: null });
      }

      const liveSlot = slots[0];
      const endTime = new Date(liveSlot.endTime);
      const now = new Date();
      const timeRemaining = Math.max(0, endTime.getTime() - now.getTime());
      const showCountdown = timeRemaining <= settings.sessionEndCountdown * 1000;

      // SECURITY: Remove sensitive fields from public response
      const { streamKey, twitchStreamKey, rtmpUrl, ...safeLiveSlot } = liveSlot;

      return successResponse({ isLive: true,
        currentStream: {
          ...safeLiveSlot,
          timeRemaining,
          showCountdown,
          countdownSeconds: showCountdown ? Math.ceil(timeRemaining / 1000) : null
        } });
    }

    // Can go live after current DJ - use D1 first
    if (action === 'canGoLiveAfter' && djId) {
      if (!settings.allowGoLiveAfter) {
        return successResponse({ canGoLiveAfter: false, reason: 'Feature disabled' });
      }

      // Try D1 first
      let liveSlots = db ? await d1GetLiveSlots(db) : [];

      // Fallback to Firebase if D1 empty
      if (liveSlots.length === 0) {
        liveSlots = await queryCollection('livestreamSlots', {
          filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
          limit: 1,
          skipCache: true
        });
      }

      if (liveSlots.length === 0) {
        return successResponse({ canGoLiveAfter: false, reason: 'No active stream' });
      }

      const currentStream = liveSlots[0];
      return successResponse({ canGoLiveAfter: true,
        currentStreamEndsAt: currentStream.endTime,
        currentDjName: currentStream.djName });
    }

    // Stream history - completed/cancelled streams (limited to prevent runaway)
    if (action === 'history') {
      // Query with limit to prevent unbounded reads
      const historySlots = await queryCollection('livestreamSlots', {
        skipCache: true,
        filters: [{ field: 'status', op: 'IN', value: ['completed', 'cancelled'] }],
        limit: 100  // Max 100 history items to prevent runaway
      });

      return successResponse({ slots: sanitizeSlots(historySlots) });
    }

    // Default: Get schedule - use D1 first (FREE reads)
    const cacheKey = `${startDate}-${endDate}-${djId || 'all'}`;
    let slots = forceRefresh ? null : getFromCache(cacheKey);
    const now = new Date();
    const skipD1 = url.searchParams.get('fresh') === '1';

    // Try D1 first for scheduled slots (FREE and fast), unless fresh=1 is set
    let allSlots = (db && !skipD1) ? await d1GetScheduledSlots(db, startDate) : [];

    // Fall back to Firebase if D1 is empty or bypassed
    if (allSlots.length === 0) {
      allSlots = await queryCollection('livestreamSlots', {
        skipCache: true,
        limit: 200
      });
    }

    // Check D1 for live slots to see if auto-end check is needed
    const d1LiveSlots = db ? await d1GetLiveSlots(db) : [];

    // Only check Firebase for auto-end if D1 shows live slots OR randomly (10% of requests for safety)
    const shouldCheckAutoEnd = d1LiveSlots.length > 0 || Math.random() < 0.1;

    if (shouldCheckAutoEnd) {
      // Get live slots from Firebase for accurate auto-end check
      const firebaseLiveSlots = await queryCollection('livestreamSlots', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
        limit: 5,
        skipCache: true
      });

      // Auto-end expired live slots
      for (const liveSlot of firebaseLiveSlots) {
        const slotEnd = new Date(liveSlot.endTime as string);
        if (now > slotEnd) {
          // Check if ANOTHER DJ has a slot starting soon — only cut off if someone else needs the slot
          const upcomingAllSlots = await queryCollection('livestreamSlots', {
            filters: [{ field: 'startTime', op: 'GREATER_THAN_OR_EQUAL', value: slotEnd.toISOString() }],
            limit: 10,
            skipCache: true
          });

          const anotherDjWaiting = upcomingAllSlots.some((s: Record<string, unknown>) => {
            if (s.djId === liveSlot.djId) return false; // Same DJ doesn't count
            if (!['scheduled', 'in_lobby', 'queued'].includes(s.status as string)) return false;
            const nextStart = new Date(s.startTime as string);
            // Another DJ's slot starts within 15 minutes of this slot's end
            return nextStart.getTime() - slotEnd.getTime() <= 15 * 60 * 1000;
          });

          // Enforce max duration: 2hr standard, 2hr + approved event hours for Plus
          const startedAt = new Date((liveSlot.startedAt || liveSlot.startTime) as string);
          const streamDurationMs = now.getTime() - startedAt.getTime();
          let maxDurationMs = 2 * 60 * 60 * 1000; // 2 hours default
          try {
            const djUser = await getDocument('users', liveSlot.djId as string);
            const sub = djUser?.subscription || { tier: 'free' };
            const djIsPlus = sub.tier === 'pro' && sub.expiresAt && new Date(sub.expiresAt) > now;
            if (djIsPlus) {
              // Check for approved event requests for today
              const todayDate = now.toISOString().split('T')[0];
              try {
                const eventReqs = await queryCollection('event-requests', {
                  filters: [
                    { field: 'userId', op: 'EQUAL', value: liveSlot.djId as string },
                    { field: 'eventDate', op: 'EQUAL', value: todayDate },
                    { field: 'status', op: 'EQUAL', value: 'approved' }
                  ],
                  limit: 1
                });
                const approvedHours = eventReqs.length > 0 ? (eventReqs[0].hoursRequested || 0) : 0;
                // Plus base = 4hr minimum, or 2hr + approved event hours (whichever is greater)
                maxDurationMs = Math.max(4, 2 + approvedHours) * 60 * 60 * 1000;
              } catch (evErr) {
                // If event check fails, give Plus users 4hr default
                maxDurationMs = 4 * 60 * 60 * 1000;
              }
            }
          } catch (userErr) {
            log.warn('Could not check DJ subscription for auto-end:', userErr);
          }
          const exceededMaxDuration = streamDurationMs >= maxDurationMs;

          const shouldAutoEnd = anotherDjWaiting || exceededMaxDuration;

          if (shouldAutoEnd) {
            const reason = anotherDjWaiting ? 'next_dj_waiting' : 'max_duration_reached';
            log.info(`Auto-ending slot ${liveSlot.id} for ${liveSlot.djName} (${reason})`);
            try {
              await updateDocument('livestreamSlots', liveSlot.id, {
                status: 'completed',
                endedAt: now.toISOString(),
                updatedAt: now.toISOString(),
                autoEnded: true,
                autoEndReason: reason
              });

              // Sync to D1
              syncSlotStatusToD1(db, liveSlot.id, 'completed', {
                endedAt: now.toISOString(),
                autoEnded: true
              });

              // Broadcast end via Pusher
              await broadcastLiveStatus('stream-ended', {
                djId: liveSlot.djId,
                djName: liveSlot.djName,
                slotId: liveSlot.id,
                reason: reason
              }, env);

              invalidateCache();

              // Clear all caches so status endpoint returns fresh data
              clearCache('livestreamSlots');
              await kvDelete('general', { prefix: 'status' });
              await invalidateStatusCache();
            } catch (autoEndError: unknown) {
              log.error('Failed to auto-end slot:', autoEndError);
            }
          }
        }
      }
    }

    // Filter slots for the requested date range
    slots = allSlots.filter((slot: Record<string, unknown>) => (slot.startTime as string) >= startDate && (slot.startTime as string) <= endDate);
    if (djId) slots = slots.filter((slot: Record<string, unknown>) => slot.djId === djId);

    const nowISO = now.toISOString();
    // Find any slot that's currently live (regardless of scheduled end time - they might still be streaming)
    const liveSlot = slots.find((slot: Record<string, unknown>) => slot.status === 'live');
    const upcomingSlots = slots.filter((slot: Record<string, unknown>) => (slot.startTime as string) > nowISO && ['scheduled', 'in_lobby', 'queued'].includes(slot.status as string));

    // SECURITY: Sanitize all slots to remove stream keys from public response
    return successResponse({ slots: sanitizeSlots(slots),
      currentLive: sanitizeSlot(liveSlot) || null,
      upcoming: sanitizeSlots(upcomingSlots),
      total: slots.length,
      settings: {
        sessionEndCountdown: settings.sessionEndCountdown,
        allowGoLiveNow: settings.allowGoLiveNow,
        allowGoLiveAfter: settings.allowGoLiveAfter
      } }, 200, { headers: { 'Cache-Control': 'no-store' } });

  } catch (error: unknown) {
    log.error('GET Error:', error);
    return ApiErrors.serverError('Failed to fetch schedule');
  }
};

// POST: Book, cancel, go live, etc.
export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimitPost = checkRateLimit(`livestream-slots-post:${clientId}`, RateLimiters.standard);
  if (!rateLimitPost.allowed) {
    return rateLimitResponse(rateLimitPost.retryAfter!);
  }

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
    const now = new Date();
    const nowISO = now.toISOString();

    // Extract auth token from Authorization header (Bearer token)
    const authHeader = request.headers.get('Authorization');
    const idToken = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : data.idToken; // Fall back to body for backwards compatibility

    // Verify authenticated user
    const { userId: authUserId, error: authError } = await verifyRequestUser(request);
    if (!authUserId || authError) {
      return ApiErrors.unauthorized('Authentication required');
    }

    const settings = await getSettings();

    // BOOK A SLOT
    if (action === 'book') {
      const { djId, djName, djAvatar, startTime, duration, title, genre, description } = data;

      // Verify the authenticated user matches the DJ booking
      if (authUserId !== djId) {
        return ApiErrors.forbidden('Not authorized to book for this DJ');
      }

      if (!djId || !startTime || !duration || !djName) {
        const missing = [];
        if (!djId) missing.push('djId');
        if (!startTime) missing.push('startTime');
        if (!duration) missing.push('duration');
        if (!djName) missing.push('djName');
        return ApiErrors.badRequest(`Missing required fields: ${missing.join(', ')}`);
      }

      if (!SLOT_DURATIONS.includes(duration)) {
        return ApiErrors.badRequest('Invalid duration');
      }

      let slotStart = new Date(startTime);
      let slotEnd = new Date(slotStart.getTime() + duration * 60 * 1000);

      // Allow booking up to 2 minutes in the past (for instant booking tolerance)
      const toleranceMs = 2 * 60 * 1000;
      if (slotStart.getTime() < now.getTime() - toleranceMs) {
        return ApiErrors.badRequest('Cannot book in the past');
      }

      // If start time is in the past (but within tolerance), adjust to now
      if (slotStart.getTime() < now.getTime()) {
        slotStart = new Date(now.getTime());
        slotEnd = new Date(slotStart.getTime() + duration * 60 * 1000);
      }

      // Admins bypass streaming limits
      const bookIsAdmin = await isAdmin(djId);

      // Check subscription limits for streaming
      if (!bookIsAdmin) try {
        const usageDoc = await getDocument('userUsage', djId);
        const userDoc = await getDocument('users', djId);
        const subscription = userDoc?.subscription || { tier: 'free' };
        // Tier value is 'pro' in database, displayed as "Plus" to users
        const isPlus = subscription.tier === 'pro' && subscription.expiresAt && new Date(subscription.expiresAt) > now;

        // Check advance booking limit: Standard = 7 days, Plus = 30 days
        const maxAdvanceDays = isPlus ? 30 : 7;
        const maxBookingDate = new Date(now.getTime() + maxAdvanceDays * 24 * 60 * 60 * 1000);
        if (slotStart > maxBookingDate) {
          const upgradeMsg = !isPlus ? ' Go Plus to book up to 1 month in advance.' : '';
          return ApiErrors.badRequest('Cannot book more than ${maxAdvanceDays} days in advance.${upgradeMsg}');
        }

        // Get the date of the booking to check for approved events
        const bookingDate = slotStart.toISOString().split('T')[0];
        const today = now.toISOString().split('T')[0];

        // Check for approved event requests for this date
        let approvedEventHours = 0;
        if (isPlus) {
          try {
            const eventRequests = await queryCollection('event-requests', {
              filters: [
                { field: 'userId', op: 'EQUAL', value: djId },
                { field: 'eventDate', op: 'EQUAL', value: bookingDate },
                { field: 'status', op: 'EQUAL', value: 'approved' }
              ],
              limit: 1
            });
            if (eventRequests.length > 0) {
              approvedEventHours = eventRequests[0].hoursRequested || 0;
            }
          } catch (eventErr: unknown) {
            log.warn('Could not check event requests:', eventErr);
          }
        }

        // Both tiers get 2 hours/day base. Plus can request extended hours for long events.
        const baseMinutes = 120; // 2 hours for everyone
        const maxMinutes = baseMinutes + (approvedEventHours * 60);

        const minutesToday = (usageDoc?.dayDate === today ? usageDoc.streamMinutesToday : 0) || 0;

        if (minutesToday + duration > maxMinutes) {
          const hoursUsed = Math.floor(minutesToday / 60);
          const hoursLimit = maxMinutes / 60;
          const upgradeMsg = !isPlus && approvedEventHours === 0
            ? ' Go Plus to request extended hours for long events.'
            : (isPlus && approvedEventHours === 0 ? ' Request extended hours for events.' : '');
          return ApiErrors.badRequest(`You've used ${hoursUsed} of your ${hoursLimit} hour${hoursLimit > 1 ? 's' : ''} today.${upgradeMsg}`);
        }
      } catch (limitError: unknown) {
        log.warn('Could not check streaming limits:', limitError);
        // Continue with booking if limit check fails
      }

      // Acquire distributed lock to prevent TOCTOU race condition
      // (two DJs booking the same slot simultaneously)
      const lockAcquired = await acquireCronLock(db, 'slot_booking');
      if (!lockAcquired) {
        return ApiErrors.badRequest('Booking system busy — please try again in a moment');
      }

      try {
        // Check for conflicts - limit to prevent runaway
        const existingSlots = await queryCollection('livestreamSlots', { skipCache: true, limit: 200 });

        const conflicts = existingSlots.filter(slot => {
          if (!['scheduled', 'in_lobby', 'live', 'queued'].includes(slot.status)) {
            return false;
          }
          const existingEnd = new Date(slot.endTime);
          // Skip stale slots whose endTime has already passed
          if (existingEnd < now) {
            return false;
          }
          // Skip the DJ's own scheduled slots — rebooking supersedes them
          if (slot.djId === djId && slot.status === 'scheduled') {
            return false;
          }
          const existingStart = new Date(slot.startTime);
          const check1 = slotStart < existingEnd;
          const check2 = slotEnd > existingStart;

          return check1 && check2;
        });

        if (conflicts.length > 0) {
          const c = conflicts[0];
          await releaseCronLock(db, 'slot_booking');
          return ApiErrors.badRequest(`Time conflicts with ${c.djName}'s booking`);
        }

        const slotId = generateId();
        const streamKey = generateStreamKey(djId, slotId, slotStart, slotEnd);

        const newSlot = {
          djId,
          djName: djName.trim(),
          djAvatar: djAvatar || null,
          title: title || `${djName.trim()} Live`,
          genre: genre || 'Jungle / D&B',
          description: description || '',
          startTime: slotStart.toISOString(),
          endTime: slotEnd.toISOString(),
          duration,
          status: 'scheduled',
          streamKey,
          rtmpUrl: buildRtmpUrl(streamKey),
          hlsUrl: buildHlsUrl(streamKey),
          createdAt: nowISO,
          updatedAt: nowISO,
          viewerPeak: 0,
          totalViews: 0,
          currentViewers: 0,
        };

        await setDocument('livestreamSlots', slotId, newSlot, idToken);
        invalidateCache();

        // Release lock after successful booking
        await releaseCronLock(db, 'slot_booking');

        // Sync to D1 (non-blocking)
        syncSlotToD1(db, slotId, { id: slotId, ...newSlot });

        return successResponse({ slot: { id: slotId, ...newSlot },
          streamKey,
          message: 'Slot booked successfully' });
      } catch (bookingError: unknown) {
        // Release lock on any error during booking
        await releaseCronLock(db, 'slot_booking').catch(() => {});
        throw bookingError;
      }
    }

    // GO LIVE NOW
    if (action === 'go_live_now') {
      if (!settings.allowGoLiveNow) {
        return ApiErrors.badRequest('Go Live Now disabled');
      }

      const { djId, djName, djAvatar, title, genre, description } = data;

      if (!djId || !djName) {
        return ApiErrors.badRequest('DJ ID and name required');
      }

      // Verify the authenticated user matches the DJ going live
      if (authUserId !== djId) {
        return ApiErrors.forbidden('Not authorized to go live as this DJ');
      }

      // Server-side eligibility check
      const goLiveNowEligibility = await checkDjEligible(djId);
      if (!goLiveNowEligibility.eligible) {
        return ApiErrors.forbidden(goLiveNowEligibility.reason || 'Not eligible to stream');
      }

      // Check if anyone is live
      const liveSlots = await queryCollection('livestreamSlots', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
        limit: 1,
        skipCache: true
      });

      if (liveSlots.length > 0) {
        return ApiErrors.badRequest('Someone is already streaming');
      }

      const endTime = new Date(now);
      endTime.setMinutes(0, 0, 0);
      endTime.setHours(endTime.getHours() + 1);
      if (now.getMinutes() >= 55) endTime.setHours(endTime.getHours() + 1);

      const slotId = generateId();
      const streamKey = generateStreamKey(djId, slotId, now, endTime);

      const newSlot = {
        djId,
        djName: djName.trim(),
        djAvatar: djAvatar || null,
        startTime: nowISO,
        endTime: endTime.toISOString(),
        duration: Math.round((endTime.getTime() - now.getTime()) / 60000),
        title: title || `${djName.trim()} - Live Now`,
        genre: genre || 'Jungle / D&B',
        description: description || '',
        streamKey,
        rtmpUrl: buildRtmpUrl(streamKey),
        hlsUrl: buildHlsUrl(streamKey),
        status: 'live',
        createdAt: nowISO,
        startedAt: nowISO,
        viewerPeak: 0,
        totalViews: 0,
        currentViewers: 0,
      };

      await setDocument('livestreamSlots', slotId, newSlot, idToken);
      invalidateCache();

      // Sync to D1 (non-blocking)
      syncSlotToD1(db, slotId, { id: slotId, ...newSlot });

      // Invalidate Cloudflare Cache API cache so status returns fresh data
      await invalidateStatusCache();

      // Broadcast via Pusher for instant client updates
      await broadcastLiveStatus('stream-started', {
        djId,
        djName: djName.trim(),
        slotId,
        title: newSlot.title
      }, env);

      return successResponse({ slot: { id: slotId, ...newSlot },
        streamKey,
        rtmpUrl: newSlot.rtmpUrl,
        hlsUrl: newSlot.hlsUrl });
    }

    // EARLY START - Extend an upcoming booking to start now
    if (action === 'early_start') {
      const { djId } = data;

      if (!djId) {
        return ApiErrors.badRequest('DJ ID required');
      }

      // Check if anyone is currently live (skip stale slots with expired endTime)
      const liveSlots = await queryCollection('livestreamSlots', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
        limit: 5,
        skipCache: true
      });
      const activeLive = liveSlots.filter(s => new Date(s.endTime) > now);

      if (activeLive.length > 0 && activeLive[0].djId !== djId) {
        return ApiErrors.badRequest('Someone is already streaming');
      }

      // Find DJ's next scheduled booking within 2 hours
      const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);
      const djSlots = await queryCollection('livestreamSlots', {
        filters: [{ field: 'djId', op: 'EQUAL', value: djId }],
        skipCache: true
      });

      const upcomingSlot = djSlots
        .filter(s => s.status === 'scheduled')
        .filter(s => {
          const startTime = new Date(s.startTime);
          return startTime > now && startTime <= twoHoursFromNow;
        })
        .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())[0];

      if (!upcomingSlot) {
        return ApiErrors.badRequest('No upcoming booking found within 2 hours. Book a slot first or use Go Live Now.');
      }

      // Check for conflicts with other slots between now and the upcoming slot's start
      const originalStart = new Date(upcomingSlot.startTime);
      const originalEnd = new Date(upcomingSlot.endTime);

      const conflicts = djSlots.filter(s => {
        if (s.id === upcomingSlot.id) return false;
        if (!['scheduled', 'in_lobby', 'live'].includes(s.status)) return false;
        const existingStart = new Date(s.startTime);
        const existingEnd = new Date(s.endTime);
        return now < existingEnd && originalEnd > existingStart;
      });

      if (conflicts.length > 0) {
        return ApiErrors.badRequest('Cannot start early - conflicts with another booking');
      }

      // Extend the booking to start now
      const newStartTime = now;
      const newStreamKey = generateStreamKey(djId, upcomingSlot.id, newStartTime, originalEnd);

      await updateDocument('livestreamSlots', upcomingSlot.id, {
        startTime: newStartTime.toISOString(),
        streamKey: newStreamKey,
        rtmpUrl: buildRtmpUrl(newStreamKey),
        hlsUrl: buildHlsUrl(newStreamKey),
        earlyStart: true,
        originalStartTime: upcomingSlot.startTime,
        updatedAt: nowISO
      }, idToken);

      invalidateCache();

      // Sync early start to D1 (non-blocking)
      syncSlotToD1(db, upcomingSlot.id, {
        ...upcomingSlot,
        id: upcomingSlot.id,
        startTime: newStartTime.toISOString(),
        streamKey: newStreamKey,
        rtmpUrl: buildRtmpUrl(newStreamKey),
        hlsUrl: buildHlsUrl(newStreamKey),
        earlyStart: true
      });

      return successResponse({ message: 'Booking extended to start now',
        slot: {
          id: upcomingSlot.id,
          ...upcomingSlot,
          startTime: newStartTime.toISOString(),
          streamKey: newStreamKey,
          rtmpUrl: buildRtmpUrl(newStreamKey),
          hlsUrl: buildHlsUrl(newStreamKey),
          earlyStart: true
        },
        streamKey: newStreamKey,
        rtmpUrl: buildRtmpUrl(newStreamKey),
        hlsUrl: buildHlsUrl(newStreamKey),
        originalStartTime: upcomingSlot.startTime });
    }

    // CANCEL SLOT
    if (action === 'cancel') {
      const { slotId } = data;

      if (!slotId) {
        return ApiErrors.badRequest('Slot ID required');
      }

      const slot = await getDocument('livestreamSlots', slotId);

      if (!slot) {
        return ApiErrors.notFound('Slot not found');
      }

      // Verify the authenticated user owns the slot OR is admin
      const cancelIsAdmin = await isAdmin(authUserId);
      if (slot.djId !== authUserId && !cancelIsAdmin) {
        return ApiErrors.forbidden('Not authorized');
      }

      // Clear the stream key so the cancelled DJ can't use it
      // and a new key will be generated if another DJ books this slot
      await updateDocument('livestreamSlots', slotId, {
        status: 'cancelled',
        cancelledAt: nowISO,
        updatedAt: nowISO,
        streamKey: null,  // Invalidate the key
        keyGeneratedAt: null,
        previousDjId: slot.djId,  // Track who cancelled for audit
        previousStreamKey: slot.streamKey  // Keep for audit log
      }, idToken);

      invalidateCache();

      // Sync cancellation to D1 (non-blocking)
      syncSlotStatusToD1(db, slotId, 'cancelled', { cancelledAt: nowISO });

      return successResponse({ message: 'Slot cancelled' });
    }

    // END STREAM
    if (action === 'endStream') {
      const { slotId, djId } = data;

      // Check admin status server-side instead of trusting body
      const endStreamIsAdmin = await isAdmin(authUserId);

      let slot;
      let targetSlotId = slotId;

      // If slotId provided, use it directly
      if (slotId) {
        slot = await getDocument('livestreamSlots', slotId);
        // If the slot exists but isn't actually live, fall back to djId-based lookup
        // This handles cases where the client has a stale slotId (e.g. booked slot, not live slot)
        if (slot && slot.status !== 'live') {
          log.warn(`endStream: slotId ${slotId} has status '${slot.status}', falling back to djId lookup`);
          const liveSlots = await queryCollection('livestreamSlots', {
            filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
            skipCache: true
          });
          const fallbackSlot = endStreamIsAdmin ? liveSlots[0] : liveSlots.find(s => s.djId === authUserId);
          if (fallbackSlot) {
            slot = fallbackSlot;
            targetSlotId = fallbackSlot.id;
          }
          // If no live slot found, still proceed with the original slot (it gets set to completed, which is fine)
        }
      } else if (djId || authUserId) {
        // Otherwise find the current live slot for this DJ
        const liveSlots = await queryCollection('livestreamSlots', {
          filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
          skipCache: true
        });

        // Admin can end any stream, otherwise must be the DJ's own stream
        if (endStreamIsAdmin) {
          slot = liveSlots[0]; // End the current live stream
        } else {
          slot = liveSlots.find(s => s.djId === authUserId);
        }

        if (slot) {
          targetSlotId = slot.id;
        }
      }

      if (!slot) {
        return ApiErrors.notFound('No active stream found');
      }

      if (slot.djId !== authUserId && !endStreamIsAdmin) {
        return ApiErrors.forbidden('Not authorized');
      }

      await updateDocument('livestreamSlots', targetSlotId, {
        status: 'completed',
        endedAt: nowISO,
        updatedAt: nowISO
      });

      // Sync status change to D1 (non-blocking)
      syncSlotStatusToD1(db, targetSlotId, 'completed', { endedAt: nowISO });

      // Record streaming time for usage tracking
      try {
        const startTime = slot.startedAt || slot.startTime;
        if (startTime && slot.djId) {
          const startMs = new Date(startTime).getTime();
          const endMs = now.getTime();
          const streamMinutes = Math.ceil((endMs - startMs) / 60000);

          if (streamMinutes > 0) {
            const today = now.toISOString().split('T')[0];
            const usageDoc = await getDocument('userUsage', slot.djId) || {
              mixUploadsThisWeek: 0,
              weekStartDate: '',
              streamMinutesToday: 0,
              dayDate: ''
            };

            const currentMinutes = usageDoc.dayDate === today ? (usageDoc.streamMinutesToday || 0) : 0;

            await setDocument('userUsage', slot.djId, {
              ...usageDoc,
              streamMinutesToday: currentMinutes + streamMinutes,
              dayDate: today,
              lastStreamAt: nowISO
            });

          }
        }
      } catch (usageError: unknown) {
        log.warn('Could not record streaming usage:', usageError);
      }

      invalidateCache();

      // Clear firebase-rest in-memory cache for livestream queries
      clearCache('livestreamSlots');

      // Also invalidate KV cache so /api/livestream/status/ returns fresh data
      await kvDelete('general', { prefix: 'status' });

      // Invalidate Cloudflare Cache API cache (used by status.ts)
      await invalidateStatusCache();

      // Broadcast via Pusher for instant client updates
      await broadcastLiveStatus('stream-ended', {
        djId: slot.djId,
        djName: slot.djName,
        slotId: targetSlotId
      }, env);

      return successResponse({ message: 'Stream ended' });
    }

    // GET STREAM KEY
    if (action === 'getStreamKey') {
      const { slotId, djId } = data;

      if (!slotId || !djId) {
        return ApiErrors.badRequest('Slot ID and DJ ID required');
      }

      const slot = await getDocument('livestreamSlots', slotId);

      if (!slot) {
        return ApiErrors.notFound('Slot not found');
      }

      if (slot.djId !== djId) {
        return ApiErrors.forbidden('Not authorized');
      }

      const slotStart = new Date(slot.startTime);
      const keyAvailableAt = new Date(slotStart.getTime() - settings.streamKeyRevealMinutes * 60 * 1000);
      const graceEnd = new Date(slotStart.getTime() + settings.gracePeriodMinutes * 60 * 1000);

      if (now < keyAvailableAt) {
        return ApiErrors.badRequest('Stream key available ${settings.streamKeyRevealMinutes} minutes before your slot');
      }

      if (now > graceEnd && slot.status === 'scheduled') {
        return ApiErrors.badRequest('Grace period expired');
      }

      return successResponse({ streamKey: slot.streamKey,
        rtmpUrl: slot.rtmpUrl || buildRtmpUrl(slot.streamKey),
        hlsUrl: slot.hlsUrl || buildHlsUrl(slot.streamKey),
        serverUrl: 'rtmp://rtmp.freshwax.co.uk/live',
        slotInfo: {
          id: slotId,
          title: slot.title,
          startTime: slot.startTime,
          endTime: slot.endTime,
          status: slot.status
        } });
    }

    // GENERATE KEY for Go Live - requires a booked slot
    if (action === 'generate_key') {
      const { djId, djName, slotId } = data;

      if (!djId || !djName) {
        return ApiErrors.badRequest('DJ ID and name required');
      }

      // If slotId is provided, verify the slot belongs to this DJ and generate key for it
      if (slotId) {
        const slot = await getDocument('livestreamSlots', slotId);
        if (!slot) {
          return ApiErrors.notFound('Slot not found');
        }

        if (slot.djId !== djId) {
          return ApiErrors.forbidden('This slot belongs to another DJ');
        }

        // If slot already has a key, return it
        if (slot.streamKey) {
          return successResponse({ streamKey: slot.streamKey,
            serverUrl: 'rtmp://rtmp.freshwax.co.uk/live',
            validUntil: slot.endTime,
            slotId });
        }

        // Generate new key for this slot
        const slotStart = new Date(slot.startTime);
        const slotEnd = new Date(slot.endTime);
        const streamKey = generateStreamKey(djId, slotId, slotStart, slotEnd);

        // Save the key to the slot document
        await updateDocument('livestreamSlots', slotId, {
          streamKey,
          keyGeneratedAt: now.toISOString()
        });

        return successResponse({ streamKey,
          serverUrl: 'rtmp://rtmp.freshwax.co.uk/live',
          validUntil: slot.endTime,
          slotId });
      }

      // No slotId - check if anyone is currently live (for auto-book scenario)
      const liveSlots = await queryCollection('livestreamSlots', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
        limit: 1,
        skipCache: true
      });

      if (liveSlots.length > 0) {
        const isOwnSlot = liveSlots[0].djId === djId;
        return ApiErrors.badRequest(isOwnSlot
          ? 'You already have an active stream. End it before starting a new one.'
          : 'Another DJ is currently live. Please wait until their session ends.');
      }

      // Generate stream key valid until top of next hour (temporary key for auto-book)
      const endTime = new Date(now);
      endTime.setMinutes(0, 0, 0);
      endTime.setHours(endTime.getHours() + 1);
      if (now.getMinutes() >= 55) endTime.setHours(endTime.getHours() + 1);

      // Use a temporary slot ID prefix for generated keys
      const tempSlotId = `temp_${generateId()}`;
      const streamKey = generateStreamKey(djId, tempSlotId, now, endTime);

      return successResponse({ streamKey,
        serverUrl: 'rtmp://rtmp.freshwax.co.uk/live',
        validUntil: endTime.toISOString(),
        tempSlotId });
    }

    // GO LIVE - Validate stream is active and mark as live
    if (action === 'go_live') {
      const { djId, djName, streamKey, title, genre, twitchUsername, twitchStreamKey, broadcastMode } = data;

      if (!djId || !djName || !streamKey) {
        return ApiErrors.badRequest('DJ ID, name, and stream key required');
      }

      // Verify the authenticated user matches the DJ going live
      if (authUserId !== djId) {
        return ApiErrors.forbidden('Not authorized to go live as this DJ');
      }

      // Server-side eligibility check — prevents bypassing client-side gate
      const eligibility = await checkDjEligible(djId);
      if (!eligibility.eligible) {
        return ApiErrors.forbidden(eligibility.reason || 'Not eligible to stream');
      }

      // Check if anyone is currently live (including this DJ - prevent duplicate sessions)
      const liveSlots = await queryCollection('livestreamSlots', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
        limit: 5,
        skipCache: true
      });
      const activeLiveSlots = liveSlots.filter(s => new Date(s.endTime) > now);

      if (activeLiveSlots.length > 0) {
        const isOwnSlot = activeLiveSlots[0].djId === djId;
        return ApiErrors.badRequest(isOwnSlot
          ? 'You already have an active stream. End it before starting a new one.'
          : 'Another DJ is currently live. Please wait until their session ends.');
      }

      // Skip HLS check for browser mode — WebRTC→HLS transcode takes 10-15s for segments to appear
      const isBrowserMode = broadcastMode === 'browser';

      if (!isBrowserMode) {
        // Validate that the stream is actually active before going live
        const hlsCheckUrl = buildHlsUrl(streamKey);
        let streamActive = false;
        let streamCheckAttempts = 0;
        const maxAttempts = 2;

        while (streamCheckAttempts < maxAttempts && !streamActive) {
          streamCheckAttempts++;
          try {
            const checkResponse = await fetchWithTimeout(hlsCheckUrl.replace('/index.m3u8', '/'), {
              method: 'HEAD'
            }, 5000);
            streamActive = checkResponse.ok || checkResponse.status === 200;
            if (!streamActive && streamCheckAttempts < maxAttempts) {
              await new Promise(r => setTimeout(r, 1000)); // Wait 1s before retry
            }
          } catch (e: unknown) {
            log.warn(`Stream check attempt ${streamCheckAttempts} failed:`, e);
            if (streamCheckAttempts < maxAttempts) {
              await new Promise(r => setTimeout(r, 1000));
            }
          }
        }

        // If stream check failed after retries, warn but allow (DJ clicked Ready)
        if (!streamActive) {
          log.warn('Could not verify stream, proceeding with DJ confirmation');
        }
      }

      // Calculate end time (top of next hour)
      const endTime = new Date(now);
      endTime.setMinutes(0, 0, 0);
      endTime.setHours(endTime.getHours() + 1);
      if (now.getMinutes() >= 55) endTime.setHours(endTime.getHours() + 1);

      // Create live slot
      const slotId = generateId();

      // Determine HLS URL based on broadcast mode
      // 'placeholder' = use Icecast relay with static image (freshwax-main)
      // 'video' = use OBS video stream (stream key path)
      const useIcecastRelay = broadcastMode === 'placeholder';
      const hlsUrl = useIcecastRelay
        ? 'https://stream.freshwax.co.uk/live/freshwax-main/index.m3u8'
        : buildHlsUrl(streamKey);

      const newSlot = {
        djId,
        djName: djName.trim(),
        djAvatar: data.djAvatar || null,
        startTime: nowISO,
        endTime: endTime.toISOString(),
        duration: Math.round((endTime.getTime() - now.getTime()) / 60000),
        title: title || `${djName.trim()} - Live Now`,
        genre: genre || 'Jungle / D&B',
        description: data.description || '',
        streamKey,
        rtmpUrl: buildRtmpUrl(streamKey),
        hlsUrl,
        broadcastMode: broadcastMode || 'video', // Store for reference
        status: 'live',
        createdAt: nowISO,
        startedAt: nowISO,
        goLiveModal: true, // Mark as created via Go Live modal
        viewerPeak: 0,
        totalViews: 0,
        currentViewers: 0,
        twitchUsername: twitchUsername || null, // For Twitch chat integration
        twitchStreamKey: twitchStreamKey || null, // DJ's personal Twitch stream key for multi-streaming
      };

      try {
        await setDocument('livestreamSlots', slotId, newSlot, idToken);

        // Mark any existing scheduled/booked slots by this DJ as completed
        // (go_live creates a new slot, so the original booking is now superseded)
        try {
          const djScheduledSlots = await queryCollection('livestreamSlots', {
            filters: [
              { field: 'djId', op: 'EQUAL', value: djId },
              { field: 'status', op: 'EQUAL', value: 'scheduled' }
            ],
            skipCache: true
          });
          for (const oldSlot of djScheduledSlots) {
            if (oldSlot.id !== slotId) {
              await updateDocument('livestreamSlots', oldSlot.id, {
                status: 'completed',
                updatedAt: nowISO
              });
              syncSlotStatusToD1(db, oldSlot.id, 'completed', { updatedAt: nowISO });
            }
          }
        } catch (cleanupErr: unknown) {
          log.warn('Could not clean up scheduled slots:', cleanupErr);
        }

        invalidateCache();

        // Sync to D1 (non-blocking)
        syncSlotToD1(db, slotId, { id: slotId, ...newSlot });

        // Invalidate Cloudflare Cache API cache so status returns fresh data
        await invalidateStatusCache();

        // Broadcast via Pusher for instant client updates
        await broadcastLiveStatus('stream-started', {
          djId,
          djName: djName.trim(),
          slotId,
          title: newSlot.title
        }, env);

        return successResponse({ slot: { id: slotId, ...newSlot },
          streamKey,
          rtmpUrl: newSlot.rtmpUrl,
          hlsUrl: newSlot.hlsUrl,
          message: 'You are now live!' });
      } catch (createError: unknown) {
        log.error('Failed to create slot:', createError);
        return ApiErrors.serverError('Failed to create live slot');
      }
    }

    // UPDATE SLOT - Update DJ name, title, genre for scheduled/live slots
    // Useful for long events with multiple DJs taking turns
    if (action === 'update_slot') {
      const { slotId, djName, title, genre, description } = data;

      if (!slotId) {
        return ApiErrors.badRequest('Slot ID required');
      }

      const slot = await getDocument('livestreamSlots', slotId);

      if (!slot) {
        return ApiErrors.notFound('Slot not found');
      }

      // Only the slot owner or admin can update it - check server-side
      const updateIsAdmin = await isAdmin(authUserId);
      if (slot.djId !== authUserId && !updateIsAdmin) {
        return ApiErrors.forbidden('Not authorized to update this slot');
      }

      // Only allow updates for scheduled or live slots
      if (!['scheduled', 'in_lobby', 'live'].includes(slot.status)) {
        return ApiErrors.badRequest('Cannot update completed or cancelled slots');
      }

      // Build update object with only provided fields
      const updates: Record<string, unknown> = {
        updatedAt: nowISO
      };

      if (djName && djName.trim()) {
        updates.djName = djName.trim();
        // Track DJ changes for long events
        if (!slot.djHistory) {
          updates.djHistory = [{ djName: slot.djName, changedAt: nowISO, changedFrom: slot.djName }];
        } else {
          updates.djHistory = [...slot.djHistory, { djName: djName.trim(), changedAt: nowISO, changedFrom: slot.djName }];
        }
      }

      if (title && title.trim()) {
        updates.title = title.trim();
      }

      if (genre !== undefined) {
        updates.genre = genre.trim();
      }

      if (description !== undefined) {
        updates.description = description.trim();
      }

      await updateDocument('livestreamSlots', slotId, updates, idToken);
      invalidateCache();

      // Sync updates to D1 (non-blocking)
      syncSlotToD1(db, slotId, { ...slot, ...updates, id: slotId });

      // If the slot is live, broadcast the update for real-time UI updates
      if (slot.status === 'live') {
        await broadcastLiveStatus('stream-updated', {
          slotId,
          djName: updates.djName || slot.djName,
          title: updates.title || slot.title,
          genre: updates.genre || slot.genre
        }, env);
      }

      return successResponse({ message: 'Slot updated successfully',
        slot: { id: slotId, ...slot, ...updates } });
    }

    // START RELAY - Start a relay stream from an external source
    if (action === 'start_relay') {
      const { djId, djName, relayUrl, stationName, title, genre, twitchUsername, twitchStreamKey } = data;

      if (!djId || !djName || !relayUrl) {
        return ApiErrors.badRequest('DJ ID, name, and relay URL required');
      }

      // Check if anyone is currently live (including this DJ - prevent duplicate sessions)
      const relayLiveSlots = await queryCollection('livestreamSlots', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
        limit: 5,
        skipCache: true
      });
      const activeRelayLive = relayLiveSlots.filter(s => new Date(s.endTime) > now);

      if (activeRelayLive.length > 0) {
        const isOwnSlot = activeRelayLive[0].djId === djId;
        return ApiErrors.badRequest(isOwnSlot
          ? 'You already have an active stream. End it before starting a new one.'
          : 'Another DJ is currently live. Please wait until their session ends.');
      }

      // Verify the relay URL is from an approved station (check both streamUrl and httpsStreamUrl)
      const approvedStation = APPROVED_RELAY_STATIONS.find(s =>
        s.streamUrl === relayUrl || s.httpsStreamUrl === relayUrl
      );
      if (!approvedStation) {
        return ApiErrors.forbidden('Relay URL is not from an approved station');
      }

      // Verify the DJ has a booked slot covering the current time (admins bypass)
      const relayIsAdmin = await isAdmin(authUserId);
      let bookedSlot: Record<string, unknown> | null = null;

      if (!relayIsAdmin) {
        const djSlots = await queryCollection('livestreamSlots', {
          filters: [{ field: 'djId', op: 'EQUAL', value: djId }],
          skipCache: true
        });

        bookedSlot = djSlots.find((slot: Record<string, unknown>) => {
          if (slot.status !== 'scheduled' && slot.status !== 'in_lobby') return false;
          const slotStart = new Date(slot.startTime).getTime();
          const slotEnd = new Date(slot.endTime).getTime();
          return slotStart <= now.getTime() && now.getTime() < slotEnd;
        });

        if (!bookedSlot) {
          return ApiErrors.forbidden('You must have a booked slot to start a relay stream');
        }
      }

      // Calculate end time (top of next hour)
      const endTime = new Date(now);
      endTime.setMinutes(0, 0, 0);
      endTime.setHours(endTime.getHours() + 1);
      if (now.getMinutes() >= 55) endTime.setHours(endTime.getHours() + 1);

      // Generate a relay stream key
      const relaySlotId = generateId();
      const relayStreamKey = `relay_${djId}_${relaySlotId}`;

      const newSlot = {
        djId,
        djName: djName.trim(),
        djAvatar: data.djAvatar || null,
        startTime: nowISO,
        endTime: endTime.toISOString(),
        duration: Math.round((endTime.getTime() - now.getTime()) / 60000),
        title: title || `Live from ${stationName || 'External Station'}`,
        genre: genre || 'Jungle / D&B',
        description: data.description || '',
        streamKey: relayStreamKey,
        rtmpUrl: buildRtmpUrl(relayStreamKey),
        // Relay uses audio-only placeholder mode with turntables visualization
        hlsUrl: null,
        audioStreamUrl: relayUrl, // Play audio directly from relay source
        status: 'live',
        createdAt: nowISO,
        startedAt: nowISO,
        broadcastMode: 'placeholder', // Audio-only mode - shows turntables + waveform
        isRelay: true,
        relaySource: {
          url: relayUrl,
          stationName: stationName || 'External Station'
        },
        viewerPeak: 0,
        totalViews: 0,
        currentViewers: 0,
        twitchUsername: twitchUsername || null, // For Twitch chat integration
        twitchStreamKey: twitchStreamKey || null, // DJ's personal Twitch stream key for multi-streaming
      };

      await setDocument('livestreamSlots', relaySlotId, newSlot, idToken);
      invalidateCache();

      // Sync to D1 (non-blocking)
      syncSlotToD1(db, relaySlotId, { id: relaySlotId, ...newSlot });

      // Invalidate Cloudflare Cache API cache so status returns fresh data
      await invalidateStatusCache();

      // Broadcast via Pusher for instant client updates
      await broadcastLiveStatus('stream-started', {
        djId,
        djName: djName.trim(),
        slotId: relaySlotId,
        title: newSlot.title
      }, env);

      return successResponse({ slot: { id: relaySlotId, ...newSlot },
        streamKey: relayStreamKey,
        hlsUrl: newSlot.hlsUrl,
        message: `Relay started from ${stationName || 'external station'}!` });
    }

    return ApiErrors.badRequest('Invalid action');

  } catch (error: unknown) {
    log.error('POST Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return ApiErrors.serverError('Failed to process request: ' + errorMessage);
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
