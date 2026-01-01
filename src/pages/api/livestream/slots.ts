// src/pages/api/livestream/slots.ts
// DJ livestream schedule - uses Firebase REST API
import type { APIRoute } from 'astro';
import { queryCollection, getDocument, setDocument, updateDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { generateStreamKey as generateSecureStreamKey, buildRtmpUrl, buildHlsUrl, initRed5Env } from '../../../lib/red5';
import { broadcastLiveStatus } from '../../../lib/pusher';
import { APPROVED_RELAY_STATIONS } from '../../../lib/relay-stations';

// Helper to initialize services
function initServices(locals: any) {
  const env = locals?.runtime?.env;

  const firebaseProjectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
  const firebaseApiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

  console.log('[DEBUG] initServices - Firebase:', {
    hasProjectId: !!firebaseProjectId,
    projectId: firebaseProjectId,
    hasApiKey: !!firebaseApiKey,
    apiKeyLength: firebaseApiKey?.length || 0
  });

  initFirebaseEnv({
    FIREBASE_PROJECT_ID: firebaseProjectId,
    FIREBASE_API_KEY: firebaseApiKey,
  });

  const red5RtmpUrl = env?.RED5_RTMP_URL || import.meta.env.RED5_RTMP_URL;
  const red5HlsUrl = env?.RED5_HLS_URL || import.meta.env.RED5_HLS_URL;
  const red5Secret = env?.RED5_SIGNING_SECRET || import.meta.env.RED5_SIGNING_SECRET;

  console.log('[DEBUG] initServices - Red5:', {
    hasRtmpUrl: !!red5RtmpUrl,
    hasHlsUrl: !!red5HlsUrl,
    hasSecret: !!red5Secret
  });

  initRed5Env({
    RED5_RTMP_URL: red5RtmpUrl,
    RED5_HLS_URL: red5HlsUrl,
    RED5_SIGNING_SECRET: red5Secret,
  });
}

const SLOT_DURATIONS = [30, 45, 60, 120, 180, 240];
const MAX_BOOKING_DAYS = 30;

// SECURITY: Sanitize slot data to remove sensitive fields from public responses
function sanitizeSlot(slot: any): any {
  if (!slot) return slot;
  const { streamKey, twitchStreamKey, rtmpUrl, ...safeSlot } = slot;
  return safeSlot;
}

function sanitizeSlots(slots: any[]): any[] {
  return slots.map(sanitizeSlot);
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
const serverCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 5000;

function getFromCache(key: string): any | null {
  const entry = serverCache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) return entry.data;
  if (entry) serverCache.delete(key);
  return null;
}

function setCache(key: string, data: any): void {
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
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

// GET: Fetch schedule
export const GET: APIRoute = async ({ request, locals }) => {
  console.log('[DEBUG] slots.ts GET called');

  try {
    initServices(locals);
  } catch (initError: any) {
    console.error('[DEBUG] slots.ts initServices error:', initError?.message || initError);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to initialize services',
      details: initError?.message || 'Unknown error'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const url = new URL(request.url);
    const startDate = url.searchParams.get('start') || new Date().toISOString();
    const endDate = url.searchParams.get('end') || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const djId = url.searchParams.get('djId');
    const forceRefresh = url.searchParams.get('_t');
    const action = url.searchParams.get('action');

    console.log('[DEBUG] slots.ts params:', { startDate, endDate, djId, action });

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

      return new Response(JSON.stringify({
        success: true,
        keyAvailable,
        streamKey: keyAvailable ? streamKey : null,
        slotInfo,
        timeUntilKey,
        settings: {
          streamKeyRevealMinutes: settings.streamKeyRevealMinutes,
          gracePeriodMinutes: settings.gracePeriodMinutes,
          sessionEndCountdown: settings.sessionEndCountdown
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }

    // Current live stream
    if (action === 'currentLive') {
      const slots = await queryCollection('livestreamSlots', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
        limit: 1,
        skipCache: true
      });

      if (slots.length === 0) {
        return new Response(JSON.stringify({ success: true, isLive: false, currentStream: null }), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      }

      const liveSlot = slots[0];
      const endTime = new Date(liveSlot.endTime);
      const now = new Date();
      const timeRemaining = Math.max(0, endTime.getTime() - now.getTime());
      const showCountdown = timeRemaining <= settings.sessionEndCountdown * 1000;

      // SECURITY: Remove sensitive fields from public response
      const { streamKey, twitchStreamKey, rtmpUrl, ...safeLiveSlot } = liveSlot;

      return new Response(JSON.stringify({
        success: true,
        isLive: true,
        currentStream: {
          ...safeLiveSlot,
          timeRemaining,
          showCountdown,
          countdownSeconds: showCountdown ? Math.ceil(timeRemaining / 1000) : null
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Can go live after current DJ
    if (action === 'canGoLiveAfter' && djId) {
      if (!settings.allowGoLiveAfter) {
        return new Response(JSON.stringify({ success: true, canGoLiveAfter: false, reason: 'Feature disabled' }), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      }

      const liveSlots = await queryCollection('livestreamSlots', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
        limit: 1,
        skipCache: true
      });

      if (liveSlots.length === 0) {
        return new Response(JSON.stringify({ success: true, canGoLiveAfter: false, reason: 'No active stream' }), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      }

      const currentStream = liveSlots[0];
      return new Response(JSON.stringify({
        success: true,
        canGoLiveAfter: true,
        currentStreamEndsAt: currentStream.endTime,
        currentDjName: currentStream.djName
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Stream history - completed/cancelled streams (limited to prevent runaway)
    if (action === 'history') {
      // Query with limit to prevent unbounded reads
      const historySlots = await queryCollection('livestreamSlots', {
        skipCache: true,
        filters: [{ field: 'status', op: 'IN', value: ['completed', 'cancelled'] }],
        limit: 100  // Max 100 history items to prevent runaway
      });

      return new Response(JSON.stringify({
        success: true,
        slots: sanitizeSlots(historySlots)
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Default: Get schedule
    const cacheKey = `${startDate}-${endDate}-${djId || 'all'}`;
    let slots = forceRefresh ? null : getFromCache(cacheKey);
    const now = new Date();

    // Always fetch fresh data to check for expired live slots
    const allSlots = await queryCollection('livestreamSlots', {
      skipCache: true,
      limit: 200  // Max 200 slots to prevent runaway
    });

    // Auto-end expired live slots (unless DJ has consecutive booking) - runs on EVERY request
    const liveSlots = allSlots.filter((s: any) => s.status === 'live');
    for (const liveSlot of liveSlots) {
      const slotEnd = new Date(liveSlot.endTime);
      if (now > slotEnd) {
        // Check if DJ has a consecutive booking starting at/around their end time
        const hasConsecutive = allSlots.some((s: any) => {
          if (s.id === liveSlot.id || s.djId !== liveSlot.djId) return false;
          if (!['scheduled', 'in_lobby', 'queued'].includes(s.status)) return false;
          const nextStart = new Date(s.startTime);
          // Allow 5 minute grace between consecutive slots
          return Math.abs(nextStart.getTime() - slotEnd.getTime()) <= 5 * 60 * 1000;
        });

        if (!hasConsecutive) {
          // Auto-end this slot
          console.log(`[slots] Auto-ending expired slot ${liveSlot.id} for ${liveSlot.djName}`);
          try {
            await updateDocument('livestreamSlots', liveSlot.id, {
              status: 'completed',
              endedAt: now.toISOString(),
              updatedAt: now.toISOString(),
              autoEnded: true,
              autoEndReason: 'slot_time_expired'
            });
            // Update local allSlots data
            liveSlot.status = 'completed';
            // Broadcast end via Pusher
            const env = locals?.runtime?.env;
            await broadcastLiveStatus('stream-ended', {
              djId: liveSlot.djId,
              djName: liveSlot.djName,
              slotId: liveSlot.id,
              reason: 'time_expired'
            }, env);
            // Invalidate cache since we changed data
            invalidateCache();
          } catch (autoEndError) {
            console.error('[slots] Failed to auto-end slot:', autoEndError);
          }
        } else {
          console.log(`[slots] ${liveSlot.djName} has consecutive booking, not auto-ending`);
        }
      }
    }

    // Filter slots for the requested date range
    slots = allSlots.filter((slot: any) => slot.startTime >= startDate && slot.startTime <= endDate);
    if (djId) slots = slots.filter((slot: any) => slot.djId === djId);

    const nowISO = now.toISOString();
    // Find any slot that's currently live (regardless of scheduled end time - they might still be streaming)
    const liveSlot = slots.find((slot: any) => slot.status === 'live');
    const upcomingSlots = slots.filter((slot: any) => slot.startTime > nowISO && ['scheduled', 'in_lobby', 'queued'].includes(slot.status));

    // SECURITY: Sanitize all slots to remove stream keys from public response
    return new Response(JSON.stringify({
      success: true,
      slots: sanitizeSlots(slots),
      currentLive: sanitizeSlot(liveSlot) || null,
      upcoming: sanitizeSlots(upcomingSlots),
      total: slots.length,
      settings: {
        sessionEndCountdown: settings.sessionEndCountdown,
        allowGoLiveNow: settings.allowGoLiveNow,
        allowGoLiveAfter: settings.allowGoLiveAfter
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

  } catch (error) {
    console.error('[livestream/slots] GET Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Failed to fetch schedule' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST: Book, cancel, go live, etc.
export const POST: APIRoute = async ({ request, locals }) => {
  initServices(locals);
  const env = locals?.runtime?.env;
  try {
    const data = await request.json();
    const { action } = data;
    const now = new Date();
    const nowISO = now.toISOString();

    // Extract auth token from Authorization header (Bearer token)
    const authHeader = request.headers.get('Authorization');
    const idToken = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : data.idToken; // Fall back to body for backwards compatibility

    console.log('[livestream/slots] POST action:', action, 'hasToken:', !!idToken);

    const settings = await getSettings();

    // BOOK A SLOT
    if (action === 'book') {
      const { djId, djName, djAvatar, startTime, duration, title, genre, description } = data;

      console.log('[livestream/slots] Booking request:', { djId, djName, startTime, duration, title, hasIdToken: !!idToken });

      if (!djId || !startTime || !duration || !djName) {
        console.log('[livestream/slots] Missing required fields:', { djId: !!djId, startTime: !!startTime, duration: !!duration, djName: !!djName });
        return new Response(JSON.stringify({ success: false, error: 'Missing required fields' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }

      if (!SLOT_DURATIONS.includes(duration)) {
        return new Response(JSON.stringify({ success: false, error: `Invalid duration` }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }

      const slotStart = new Date(startTime);
      const slotEnd = new Date(slotStart.getTime() + duration * 60 * 1000);

      if (slotStart.getTime() < now.getTime()) {
        return new Response(JSON.stringify({ success: false, error: 'Cannot book in the past' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }

      // Check subscription limits for streaming
      try {
        const usageDoc = await getDocument('userUsage', djId);
        const userDoc = await getDocument('users', djId);
        const subscription = userDoc?.subscription || { tier: 'free' };
        const isPro = subscription.tier === 'pro' && subscription.expiresAt && new Date(subscription.expiresAt) > now;

        // Get the date of the booking to check for approved events
        const bookingDate = slotStart.toISOString().split('T')[0];
        const today = now.toISOString().split('T')[0];

        // Check for approved event requests for this date
        let approvedEventHours = 0;
        if (isPro) {
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
          } catch (eventErr) {
            console.warn('[livestream/slots] Could not check event requests:', eventErr);
          }
        }

        // Base limits: Pro = 2 hours, Free = 1 hour. Plus any approved event hours.
        const baseMinutes = isPro ? 120 : 60;
        const maxMinutes = baseMinutes + (approvedEventHours * 60);

        const minutesToday = (usageDoc?.dayDate === today ? usageDoc.streamMinutesToday : 0) || 0;

        if (minutesToday + duration > maxMinutes) {
          const hoursUsed = Math.floor(minutesToday / 60);
          const hoursLimit = maxMinutes / 60;
          const upgradeMsg = !isPro
            ? ' Upgrade to Pro for 2 hours per day.'
            : (approvedEventHours === 0 ? ' Request extended hours for events.' : '');
          return new Response(JSON.stringify({
            success: false,
            error: `You've used ${hoursUsed} of your ${hoursLimit} hour${hoursLimit > 1 ? 's' : ''} today.${upgradeMsg}`,
            needsUpgrade: !isPro,
            canRequestEvent: isPro && approvedEventHours === 0
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
      } catch (limitError) {
        console.warn('[livestream/slots] Could not check streaming limits:', limitError);
        // Continue with booking if limit check fails
      }

      // Check for conflicts - limit to prevent runaway
      const existingSlots = await queryCollection('livestreamSlots', { skipCache: true, limit: 200 });
      const conflicts = existingSlots.filter(slot => {
        if (!['scheduled', 'in_lobby', 'live', 'queued'].includes(slot.status)) return false;
        const existingStart = new Date(slot.startTime);
        const existingEnd = new Date(slot.endTime);
        return slotStart < existingEnd && slotEnd > existingStart;
      });

      if (conflicts.length > 0) {
        return new Response(JSON.stringify({ success: false, error: `Time conflicts with ${conflicts[0].djName}'s booking` }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
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

      console.log('[livestream/slots] Booking saved successfully:', slotId);

      return new Response(JSON.stringify({
        success: true,
        slot: { id: slotId, ...newSlot },
        streamKey,
        message: 'Slot booked successfully'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // GO LIVE NOW
    if (action === 'go_live_now') {
      if (!settings.allowGoLiveNow) {
        return new Response(JSON.stringify({ success: false, error: 'Go Live Now disabled' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }

      const { djId, djName, djAvatar, title, genre, description } = data;

      if (!djId || !djName) {
        return new Response(JSON.stringify({ success: false, error: 'DJ ID and name required' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }

      // Check if anyone is live
      const liveSlots = await queryCollection('livestreamSlots', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
        limit: 1,
        skipCache: true
      });

      if (liveSlots.length > 0) {
        return new Response(JSON.stringify({ success: false, error: 'Someone is already streaming' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
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

      // Broadcast via Pusher for instant client updates
      await broadcastLiveStatus('stream-started', {
        djId,
        djName: djName.trim(),
        slotId,
        title: newSlot.title
      }, env);

      return new Response(JSON.stringify({
        success: true,
        slot: { id: slotId, ...newSlot },
        streamKey,
        rtmpUrl: newSlot.rtmpUrl,
        hlsUrl: newSlot.hlsUrl
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // EARLY START - Extend an upcoming booking to start now
    if (action === 'early_start') {
      const { djId } = data;

      if (!djId) {
        return new Response(JSON.stringify({ success: false, error: 'DJ ID required' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }

      // Check if anyone is currently live
      const liveSlots = await queryCollection('livestreamSlots', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
        limit: 1,
        skipCache: true
      });

      if (liveSlots.length > 0 && liveSlots[0].djId !== djId) {
        return new Response(JSON.stringify({ success: false, error: 'Someone is already streaming' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
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
        return new Response(JSON.stringify({
          success: false,
          error: 'No upcoming booking found within 2 hours. Book a slot first or use Go Live Now.',
          noUpcomingBooking: true
        }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
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
        return new Response(JSON.stringify({
          success: false,
          error: 'Cannot start early - conflicts with another booking'
        }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
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

      return new Response(JSON.stringify({
        success: true,
        message: 'Booking extended to start now',
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
        originalStartTime: upcomingSlot.startTime
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // CANCEL SLOT
    if (action === 'cancel') {
      const { slotId, djId } = data;

      if (!slotId) {
        return new Response(JSON.stringify({ success: false, error: 'Slot ID required' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }

      const slot = await getDocument('livestreamSlots', slotId);

      if (!slot) {
        return new Response(JSON.stringify({ success: false, error: 'Slot not found' }), {
          status: 404, headers: { 'Content-Type': 'application/json' }
        });
      }

      if (slot.djId !== djId && !data.adminCancel) {
        return new Response(JSON.stringify({ success: false, error: 'Not authorized' }), {
          status: 403, headers: { 'Content-Type': 'application/json' }
        });
      }

      await updateDocument('livestreamSlots', slotId, {
        status: 'cancelled',
        cancelledAt: nowISO,
        updatedAt: nowISO
      }, idToken);

      invalidateCache();

      return new Response(JSON.stringify({ success: true, message: 'Slot cancelled' }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    // END STREAM
    if (action === 'endStream') {
      const { slotId, djId, isAdmin } = data;

      let slot;
      let targetSlotId = slotId;

      // If slotId provided, use it directly
      if (slotId) {
        slot = await getDocument('livestreamSlots', slotId);
      } else if (djId) {
        // Otherwise find the current live slot for this DJ
        const liveSlots = await queryCollection('livestreamSlots', {
          filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
          skipCache: true
        });

        // Admin can end any stream, otherwise must be the DJ's own stream
        if (isAdmin) {
          slot = liveSlots[0]; // End the current live stream
        } else {
          slot = liveSlots.find(s => s.djId === djId);
        }

        if (slot) {
          targetSlotId = slot.id;
        }
      }

      if (!slot) {
        return new Response(JSON.stringify({ success: false, error: 'No active stream found' }), {
          status: 404, headers: { 'Content-Type': 'application/json' }
        });
      }

      if (slot.djId !== djId && !isAdmin) {
        return new Response(JSON.stringify({ success: false, error: 'Not authorized' }), {
          status: 403, headers: { 'Content-Type': 'application/json' }
        });
      }

      await updateDocument('livestreamSlots', targetSlotId, {
        status: 'completed',
        endedAt: nowISO,
        updatedAt: nowISO
      });

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

            console.log(`[livestream/slots] Recorded ${streamMinutes} minutes streaming for ${slot.djId}`);
          }
        }
      } catch (usageError) {
        console.warn('[livestream/slots] Could not record streaming usage:', usageError);
      }

      invalidateCache();

      // Broadcast via Pusher for instant client updates
      await broadcastLiveStatus('stream-ended', {
        djId: slot.djId,
        djName: slot.djName,
        slotId: targetSlotId
      }, env);

      return new Response(JSON.stringify({ success: true, message: 'Stream ended' }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    // GET STREAM KEY
    if (action === 'getStreamKey') {
      const { slotId, djId } = data;

      if (!slotId || !djId) {
        return new Response(JSON.stringify({ success: false, error: 'Slot ID and DJ ID required' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }

      const slot = await getDocument('livestreamSlots', slotId);

      if (!slot) {
        return new Response(JSON.stringify({ success: false, error: 'Slot not found' }), {
          status: 404, headers: { 'Content-Type': 'application/json' }
        });
      }

      if (slot.djId !== djId) {
        return new Response(JSON.stringify({ success: false, error: 'Not authorized' }), {
          status: 403, headers: { 'Content-Type': 'application/json' }
        });
      }

      const slotStart = new Date(slot.startTime);
      const keyAvailableAt = new Date(slotStart.getTime() - settings.streamKeyRevealMinutes * 60 * 1000);
      const graceEnd = new Date(slotStart.getTime() + settings.gracePeriodMinutes * 60 * 1000);

      if (now < keyAvailableAt) {
        return new Response(JSON.stringify({
          success: false,
          error: `Stream key available ${settings.streamKeyRevealMinutes} minutes before your slot`,
          keyAvailableAt: keyAvailableAt.toISOString()
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      if (now > graceEnd && slot.status === 'scheduled') {
        return new Response(JSON.stringify({ success: false, error: 'Grace period expired' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        success: true,
        streamKey: slot.streamKey,
        rtmpUrl: slot.rtmpUrl || buildRtmpUrl(slot.streamKey),
        hlsUrl: slot.hlsUrl || buildHlsUrl(slot.streamKey),
        serverUrl: 'rtmp://rtmp.freshwax.co.uk/live',
        slotInfo: {
          id: slotId,
          title: slot.title,
          startTime: slot.startTime,
          endTime: slot.endTime,
          status: slot.status
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // GENERATE KEY for Go Live modal (creates temporary key, no booking yet)
    if (action === 'generate_key') {
      const { djId, djName } = data;

      if (!djId || !djName) {
        return new Response(JSON.stringify({ success: false, error: 'DJ ID and name required' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }

      // Check if anyone is currently live
      const liveSlots = await queryCollection('livestreamSlots', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
        limit: 1,
        skipCache: true
      });

      if (liveSlots.length > 0 && liveSlots[0].djId !== djId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Someone is already streaming. Use takeover if you want to go live.'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      // Generate stream key valid until top of next hour
      const endTime = new Date(now);
      endTime.setMinutes(0, 0, 0);
      endTime.setHours(endTime.getHours() + 1);
      if (now.getMinutes() >= 55) endTime.setHours(endTime.getHours() + 1);

      // Use a temporary slot ID prefix for generated keys
      const tempSlotId = `temp_${generateId()}`;
      const streamKey = generateStreamKey(djId, tempSlotId, now, endTime);

      return new Response(JSON.stringify({
        success: true,
        streamKey,
        serverUrl: 'rtmp://rtmp.freshwax.co.uk/live',
        validUntil: endTime.toISOString(),
        tempSlotId
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // GO LIVE - Validate stream is active and mark as live
    if (action === 'go_live') {
      const { djId, djName, streamKey, title, genre, twitchUsername, twitchStreamKey, broadcastMode } = data;

      if (!djId || !djName || !streamKey) {
        return new Response(JSON.stringify({ success: false, error: 'DJ ID, name, and stream key required' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }

      // Check if anyone is currently live
      const liveSlots = await queryCollection('livestreamSlots', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
        limit: 1,
        skipCache: true
      });

      if (liveSlots.length > 0 && liveSlots[0].djId !== djId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Someone is already streaming'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      // Validate that the stream is actually active before going live
      const hlsCheckUrl = buildHlsUrl(streamKey);
      let streamActive = false;
      let streamCheckAttempts = 0;
      const maxAttempts = 2;

      while (streamCheckAttempts < maxAttempts && !streamActive) {
        streamCheckAttempts++;
        try {
          const checkResponse = await fetch(hlsCheckUrl.replace('/index.m3u8', '/'), {
            method: 'HEAD',
            signal: AbortSignal.timeout(5000)
          });
          streamActive = checkResponse.ok || checkResponse.status === 200;
          if (!streamActive && streamCheckAttempts < maxAttempts) {
            await new Promise(r => setTimeout(r, 1000)); // Wait 1s before retry
          }
        } catch (e) {
          console.warn(`[go_live] Stream check attempt ${streamCheckAttempts} failed:`, e);
          if (streamCheckAttempts < maxAttempts) {
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      }

      // If stream check failed after retries, warn but allow (DJ clicked Ready)
      if (!streamActive) {
        console.warn('[go_live] Could not verify stream, proceeding with DJ confirmation');
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
        console.log('[go_live] Creating slot with idToken:', !!idToken, 'slotId:', slotId);
        await setDocument('livestreamSlots', slotId, newSlot, idToken);
        invalidateCache();

        // Broadcast via Pusher for instant client updates
        await broadcastLiveStatus('stream-started', {
          djId,
          djName: djName.trim(),
          slotId,
          title: newSlot.title
        }, env);

        return new Response(JSON.stringify({
          success: true,
          slot: { id: slotId, ...newSlot },
          streamKey,
          rtmpUrl: newSlot.rtmpUrl,
          hlsUrl: newSlot.hlsUrl,
          message: 'You are now live!'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      } catch (createError: any) {
        console.error('[go_live] Failed to create slot:', createError);
        return new Response(JSON.stringify({
          success: false,
          error: 'Failed to create live slot',
          details: createError?.message || 'Unknown error'
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // START RELAY - Start a relay stream from an external source
    if (action === 'start_relay') {
      const { djId, djName, relayUrl, stationName, title, genre } = data;

      if (!djId || !djName || !relayUrl) {
        return new Response(JSON.stringify({ success: false, error: 'DJ ID, name, and relay URL required' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }

      // Check if anyone is currently live
      const liveSlots = await queryCollection('livestreamSlots', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
        limit: 1,
        skipCache: true
      });

      if (liveSlots.length > 0 && liveSlots[0].djId !== djId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Someone is already streaming'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      // Verify the relay URL is from an approved station
      const approvedStation = APPROVED_RELAY_STATIONS.find(s => s.streamUrl === relayUrl);
      if (!approvedStation) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Relay URL is not from an approved station'
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }

      // TODO: In production, you would:
      // 1. Check if the DJ has a booked slot at this time
      // 2. Start the FFmpeg relay process to pull from relayUrl
      // 3. Verify the external stream is actually live
      // For now, we'll create the slot and trust the relay is working

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
        // Use freshwax-main HLS for relay - FFmpeg generates spectrum video from relay audio
        hlsUrl: buildHlsUrl('freshwax-main'),
        status: 'live',
        createdAt: nowISO,
        startedAt: nowISO,
        broadcastMode: 'video', // Video mode - shows spectrum visualization
        isRelay: true,
        relaySource: {
          url: relayUrl,
          stationName: stationName || 'External Station'
        },
        viewerPeak: 0,
        totalViews: 0,
        currentViewers: 0,
      };

      await setDocument('livestreamSlots', relaySlotId, newSlot, idToken);
      invalidateCache();

      // Broadcast via Pusher for instant client updates
      await broadcastLiveStatus('stream-started', {
        djId,
        djName: djName.trim(),
        slotId: relaySlotId,
        title: newSlot.title
      }, env);

      return new Response(JSON.stringify({
        success: true,
        slot: { id: relaySlotId, ...newSlot },
        streamKey: relayStreamKey,
        hlsUrl: newSlot.hlsUrl,
        message: `Relay started from ${stationName || 'external station'}!`
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ success: false, error: 'Invalid action' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[livestream/slots] POST Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to process request',
      details: errorMessage
    }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
};

// DELETE: Cancel slot
export const DELETE: APIRoute = async ({ request, locals }) => {
  initServices(locals);
  try {
    const data = await request.json();
    const { slotId, adminCancel } = data;

    if (!slotId) {
      return new Response(JSON.stringify({ success: false, error: 'Slot ID required' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    const slot = await getDocument('livestreamSlots', slotId);

    if (!slot) {
      return new Response(JSON.stringify({ success: false, error: 'Slot not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' }
      });
    }

    await updateDocument('livestreamSlots', slotId, {
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      cancelledByAdmin: adminCancel || false
    });

    invalidateCache();

    return new Response(JSON.stringify({ success: true, message: 'Slot cancelled' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[livestream/slots] DELETE Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Failed to cancel slot' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
};
