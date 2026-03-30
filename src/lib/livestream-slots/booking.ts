// src/lib/livestream-slots/booking.ts
// Booking handlers: book, cancel, update slot
import { queryCollection, getDocument, setDocument, updateDocument } from '../firebase-rest';
import { buildRtmpUrl, buildHlsUrl } from '../red5';
import { broadcastLiveStatus } from '../pusher';
import { isAdmin } from '../admin';
import { acquireCronLock, releaseCronLock } from '../cron-lock';
import { createLogger, ApiErrors, successResponse } from '../api-utils';
import {
  syncSlotToD1,
  syncSlotStatusToD1,
  SLOT_DURATIONS,
  generateStreamKey,
  invalidateCache,
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
      return ApiErrors.badRequest(`Cannot book more than ${maxAdvanceDays} days in advance.${upgradeMsg}`);
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
    await releaseCronLock(db, 'slot_booking').catch(() => { /* non-critical: lock release */ });
    throw bookingError;
  }
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
