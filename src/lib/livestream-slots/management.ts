// src/lib/livestream-slots/management.ts
// Management handlers: end stream, heartbeat, get stream key, generate key
import { queryCollection, getDocument, setDocument, updateDocument, clearCache } from '../firebase-rest';
import { buildRtmpUrl, buildHlsUrl } from '../red5';
import { broadcastLiveStatus } from '../pusher';
import { logActivity } from '../activity-feed';
import { kvDelete } from '../kv-cache';
import { isAdmin } from '../admin';
import { createLogger, ApiErrors, successResponse } from '../api-utils';
import {
  syncSlotStatusToD1,
  generateStreamKey,
  invalidateCache,
  getSettings,
  generateId,
} from './helpers';

const log = createLogger('[livestream-slots]');

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

  const endStreamUpdates: Record<string, unknown> = {
    status: 'completed',
    endedAt: nowISO,
    updatedAt: nowISO
  };
  // Cap a future-dated endTime (e.g. a relay's 24h window) to the actual end so
  // the finished session doesn't keep occupying the schedule for hours.
  if (slot.endTime && new Date(slot.endTime as string).getTime() > now.getTime()) {
    endStreamUpdates.endTime = nowISO;
  }
  await updateDocument('livestreamSlots', targetSlotId, endStreamUpdates);

  // Sync status change to D1 (non-blocking)
  syncSlotStatusToD1(db, targetSlotId, 'completed', { endedAt: nowISO, ...(endStreamUpdates.endTime ? { endTime: nowISO } : {}) });

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

// Extend a live slot by one hour (the DJ opted to "keep streaming" on the 5-min
// prompt). Pushes endTime to the next hour boundary, capped to the next booked
// DJ's start time; refuses if another DJ is up next. Extension is opt-in — the
// server no longer auto-extends, so this is the only way to carry past the hour.
export async function handleExtendSlot(
  data: Record<string, unknown>,
  authUserId: string,
  db: unknown,
  env: Record<string, unknown>,
  now: Date,
  nowISO: string,
  invalidateStatusCacheFn: () => Promise<void>
): Promise<Response> {
  const { slotId } = data as { slotId?: string };
  const extendIsAdmin = await isAdmin(authUserId);

  // Resolve the live slot — prefer slotId, fall back to the caller's live slot.
  let slot;
  let targetSlotId = slotId;
  if (slotId) {
    slot = await getDocument('livestreamSlots', slotId);
  }
  if (!slot || slot.status !== 'live') {
    const liveSlots = await queryCollection('livestreamSlots', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'live' }],
      skipCache: true
    });
    slot = extendIsAdmin ? liveSlots[0] : liveSlots.find(s => s.djId === authUserId);
    if (slot) targetSlotId = slot.id;
  }

  if (!slot) return ApiErrors.notFound('No active stream to extend');
  if (slot.djId !== authUserId && !extendIsAdmin) return ApiErrors.forbidden('Not authorized');
  if (slot.isRelay === true) return ApiErrors.badRequest('Relay streams cannot be extended this way');

  // Next hour boundary after the current end.
  const currentEnd = new Date((slot.endTime as string) || nowISO);
  const newEnd = new Date(currentEnd);
  newEnd.setMinutes(0, 0, 0);
  newEnd.setHours(newEnd.getHours() + 1);
  while (newEnd.getTime() <= currentEnd.getTime()) newEnd.setHours(newEnd.getHours() + 1);

  // Don't extend into another DJ's booked slot. If they start before the new
  // end, cap to their start; if they're already up at the hour, refuse.
  const upcoming = await queryCollection('livestreamSlots', {
    filters: [{ field: 'startTime', op: 'GREATER_THAN_OR_EQUAL', value: currentEnd.toISOString() }],
    orderBy: { field: 'startTime', direction: 'ASCENDING' },
    limit: 10,
    skipCache: true
  });
  const nextOther = upcoming.find(s => s.djId !== slot.djId && ['scheduled', 'in_lobby', 'queued'].includes(s.status as string));
  if (nextOther) {
    const nextStart = new Date(nextOther.startTime as string);
    if (nextStart.getTime() <= currentEnd.getTime()) {
      return ApiErrors.conflict('The next slot is booked by another DJ — you can\'t extend.');
    }
    if (nextStart.getTime() < newEnd.getTime()) newEnd.setTime(nextStart.getTime());
  }

  await updateDocument('livestreamSlots', targetSlotId as string, {
    endTime: newEnd.toISOString(),
    extended: true,
    lastExtendedAt: nowISO,
    updatedAt: nowISO
  });

  // Sync the new end to D1 before responding (the schedule reads D1 first).
  try {
    await syncSlotStatusToD1(db, targetSlotId as string, 'live', { endTime: newEnd.toISOString() });
  } catch (d1Err: unknown) {
    log.warn('extend: D1 sync failed:', d1Err instanceof Error ? d1Err.message : d1Err);
  }

  invalidateCache();
  clearCache('livestreamSlots');
  await kvDelete('general', { prefix: 'status' });
  await invalidateStatusCacheFn();

  await broadcastLiveStatus('stream-updated', {
    slotId: targetSlotId,
    djId: slot.djId,
    djName: slot.djName,
    endTime: newEnd.toISOString()
  }, env);

  return successResponse({ message: 'Slot extended', endTime: newEnd.toISOString() });
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
  authUserId: string,
  now: Date
): Promise<Response> {
  const { slotId, djId } = data as { slotId?: string; djId?: string };
  const settings = await getSettings();

  if (!slotId || !djId) {
    return ApiErrors.badRequest('Slot ID and DJ ID required');
  }

  // Authorize against the verified token, not the body djId. A caller may only
  // read their own slot's key (admins may read any). Without this an
  // authenticated user could pass a victim's djId and harvest their key.
  const getKeyIsAdmin = await isAdmin(authUserId);
  if (authUserId !== djId && !getKeyIsAdmin) {
    return ApiErrors.forbidden('Not authorized');
  }

  const slot = await getDocument('livestreamSlots', slotId);

  if (!slot) {
    return ApiErrors.notFound('Slot not found');
  }

  if (slot.djId !== djId && !getKeyIsAdmin) {
    return ApiErrors.forbidden('Not authorized');
  }

  const slotStart = new Date(slot.startTime);
  const keyAvailableAt = new Date(slotStart.getTime() - settings.streamKeyRevealMinutes * 60 * 1000);
  const graceEnd = new Date(slotStart.getTime() + settings.gracePeriodMinutes * 60 * 1000);

  if (now < keyAvailableAt) {
    return ApiErrors.badRequest(`Stream key available ${settings.streamKeyRevealMinutes} minutes before your slot`);
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
  authUserId: string,
  now: Date
): Promise<Response> {
  const { djId, djName, slotId } = data as { djId?: string; djName?: string; slotId?: string };

  if (!djId || !djName) {
    return ApiErrors.badRequest('DJ ID and name required');
  }

  // Authorize against the verified token, not the body djId — a caller may only
  // generate/read a key for their own DJ identity (admins may act for anyone).
  const genKeyIsAdmin = await isAdmin(authUserId);
  if (authUserId !== djId && !genKeyIsAdmin) {
    return ApiErrors.forbidden('Not authorized');
  }

  // If slotId is provided, verify the slot belongs to this DJ and generate key for it
  if (slotId) {
    const slot = await getDocument('livestreamSlots', slotId);
    if (!slot) {
      return ApiErrors.notFound('Slot not found');
    }

    if (slot.djId !== djId && !genKeyIsAdmin) {
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
