// src/lib/livestream-slots/post-actions.ts
// POST handler logic for livestream slots
import { queryCollection, getDocument, setDocument, updateDocument, clearCache } from '../firebase-rest';
import { buildRtmpUrl, buildHlsUrl } from '../red5';
import { broadcastLiveStatus } from '../pusher';
import { logActivity } from '../activity-feed';
import { APPROVED_RELAY_STATIONS } from '../relay-stations';
import { kvDelete } from '../kv-cache';
import { isAdmin } from '../admin';
import { acquireCronLock, releaseCronLock } from '../cron-lock';
import { createLogger, ApiErrors, fetchWithTimeout, successResponse } from '../api-utils';
import {
  initServices,
  syncSlotToD1,
  syncSlotStatusToD1,
  SLOT_DURATIONS,
  checkDjEligible,
  generateStreamKey,
  invalidateCache,
  getSettings,
  generateId,
} from './helpers';

const log = createLogger('[livestream-slots]');

export async function handleBook(
  data: Record<string, unknown>,
  authUserId: string,
  idToken: string | null | undefined,
  db: unknown,
  now: Date,
  nowISO: string
): Promise<Response> {
  const { djId, djName, djAvatar, startTime, duration, title, genre, description } = data as {
    djId?: string; djName?: string; djAvatar?: string; startTime?: string;
    duration?: number; title?: string; genre?: string; description?: string;
  };

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

export async function handleGoLiveNow(
  data: Record<string, unknown>,
  authUserId: string,
  idToken: string | null | undefined,
  db: unknown,
  env: Record<string, unknown>,
  now: Date,
  nowISO: string,
  invalidateStatusCacheFn: () => Promise<void>
): Promise<Response> {
  const settings = await getSettings();
  if (!settings.allowGoLiveNow) {
    return ApiErrors.badRequest('Go Live Now disabled');
  }

  const { djId, djName, djAvatar, title, genre, description } = data as {
    djId?: string; djName?: string; djAvatar?: string;
    title?: string; genre?: string; description?: string;
  };

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
    djName: (djName as string).trim(),
    djAvatar: djAvatar || null,
    startTime: nowISO,
    endTime: endTime.toISOString(),
    duration: Math.round((endTime.getTime() - now.getTime()) / 60000),
    title: title || `${(djName as string).trim()} - Live Now`,
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
  await invalidateStatusCacheFn();

  // Broadcast via Pusher for instant client updates
  await broadcastLiveStatus('stream-started', {
    djId,
    djName: (djName as string).trim(),
    slotId,
    title: newSlot.title
  }, env);

  // Log to activity feed (non-blocking)
  if (db) {
    logActivity(db, {
      eventType: 'dj_went_live',
      actorId: djId,
      actorName: (djName as string).trim(),
      targetId: slotId,
      targetType: 'livestream',
      targetName: newSlot.title,
      targetUrl: '/live/',
    }).catch(() => { /* activity logging non-critical */ });
  }

  return successResponse({ slot: { id: slotId, ...newSlot },
    streamKey,
    rtmpUrl: newSlot.rtmpUrl,
    hlsUrl: newSlot.hlsUrl });
}

export async function handleEarlyStart(
  data: Record<string, unknown>,
  authUserId: string,
  idToken: string | null | undefined,
  db: unknown,
  now: Date,
  nowISO: string
): Promise<Response> {
  const { djId } = data as { djId?: string };

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

export async function handleCancel(
  data: Record<string, unknown>,
  authUserId: string,
  idToken: string | null | undefined,
  db: unknown,
  nowISO: string
): Promise<Response> {
  const { slotId } = data as { slotId?: string };

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

export async function handleEndStream(
  data: Record<string, unknown>,
  authUserId: string,
  db: unknown,
  env: Record<string, unknown>,
  now: Date,
  nowISO: string,
  invalidateStatusCacheFn: () => Promise<void>
): Promise<Response> {
  const { slotId, djId } = data as { slotId?: string; djId?: string };

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
  await invalidateStatusCacheFn();

  // Broadcast via Pusher for instant client updates
  await broadcastLiveStatus('stream-ended', {
    djId: slot.djId,
    djName: slot.djName,
    slotId: targetSlotId
  }, env);

  // Log to activity feed (non-blocking)
  if (db) {
    logActivity(db, {
      eventType: 'stream_ended',
      actorId: slot.djId,
      actorName: slot.djName,
      targetId: targetSlotId,
      targetType: 'livestream',
      targetUrl: '/live/',
    }).catch(() => { /* activity logging non-critical */ });
  }

  return successResponse({ message: 'Stream ended' });
}

export async function handleHeartbeat(
  data: Record<string, unknown>,
  authUserId: string,
  db: unknown,
  nowISO: string
): Promise<Response> {
  const { slotId } = data as { slotId?: string };
  if (!slotId) return ApiErrors.badRequest('Slot ID required');

  const slot = await getDocument('livestreamSlots', slotId);
  if (!slot || slot.status !== 'live') {
    return ApiErrors.notFound('No active stream found');
  }
  if (slot.djId !== authUserId) {
    return ApiErrors.forbidden('Not authorized');
  }

  await updateDocument('livestreamSlots', slotId, {
    lastHeartbeat: nowISO
  });

  // Also update D1 (non-blocking)
  syncSlotStatusToD1(db, slotId, 'live', { lastHeartbeat: nowISO });

  return successResponse({ ok: true });
}

export async function handleGetStreamKey(
  data: Record<string, unknown>,
  now: Date
): Promise<Response> {
  const { slotId, djId } = data as { slotId?: string; djId?: string };
  const settings = await getSettings();

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

export async function handleGenerateKey(
  data: Record<string, unknown>,
  now: Date
): Promise<Response> {
  const { djId, djName, slotId } = data as { djId?: string; djName?: string; slotId?: string };

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

export async function handleGoLive(
  data: Record<string, unknown>,
  authUserId: string,
  idToken: string | null | undefined,
  db: unknown,
  env: Record<string, unknown>,
  now: Date,
  nowISO: string,
  invalidateStatusCacheFn: () => Promise<void>
): Promise<Response> {
  const { djId, djName, streamKey, title, genre, twitchUsername, twitchStreamKey, broadcastMode } = data as {
    djId?: string; djName?: string; streamKey?: string; title?: string;
    genre?: string; twitchUsername?: string; twitchStreamKey?: string; broadcastMode?: string;
  };

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

  // Skip HLS check for browser mode — WebRTC->HLS transcode takes 10-15s for segments to appear
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
    djAvatar: (data as Record<string, unknown>).djAvatar || null,
    startTime: nowISO,
    endTime: endTime.toISOString(),
    duration: Math.round((endTime.getTime() - now.getTime()) / 60000),
    title: title || `${djName.trim()} - Live Now`,
    genre: genre || 'Jungle / D&B',
    description: ((data as Record<string, unknown>).description as string) || '',
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
    await invalidateStatusCacheFn();

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

export async function handleUpdateSlot(
  data: Record<string, unknown>,
  authUserId: string,
  idToken: string | null | undefined,
  db: unknown,
  env: Record<string, unknown>,
  nowISO: string
): Promise<Response> {
  const { slotId, djName, title, genre, description } = data as {
    slotId?: string; djName?: string; title?: string; genre?: string; description?: string;
  };

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

export async function handleStartRelay(
  data: Record<string, unknown>,
  authUserId: string,
  idToken: string | null | undefined,
  db: unknown,
  env: Record<string, unknown>,
  now: Date,
  nowISO: string,
  invalidateStatusCacheFn: () => Promise<void>
): Promise<Response> {
  const { djId, djName, relayUrl, stationName, title, genre, twitchUsername, twitchStreamKey } = data as {
    djId?: string; djName?: string; relayUrl?: string; stationName?: string;
    title?: string; genre?: string; twitchUsername?: string; twitchStreamKey?: string;
  };

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

  // Relay streams run until manually ended — set endTime 24 hours ahead
  const endTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  // Generate a relay stream key
  const relaySlotId = generateId();
  const relayStreamKey = `relay_${djId}_${relaySlotId}`;

  const newSlot = {
    djId,
    djName: djName.trim(),
    djAvatar: (data as Record<string, unknown>).djAvatar || null,
    startTime: nowISO,
    endTime: endTime.toISOString(),
    duration: Math.round((endTime.getTime() - now.getTime()) / 60000),
    title: title || `Live from ${stationName || 'External Station'}`,
    genre: genre || 'Jungle / D&B',
    description: ((data as Record<string, unknown>).description as string) || '',
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
  await invalidateStatusCacheFn();

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
