// src/lib/livestream-slots/get-actions.ts
// GET handler logic for livestream slots
import { queryCollection, getDocument, updateDocument, clearCache } from '../firebase-rest';
import { broadcastLiveStatus } from '../pusher';
import { kvDelete } from '../kv-cache';
import { d1GetLiveSlots, d1GetScheduledSlots } from '../d1-catalog';
import { createLogger, ApiErrors, successResponse } from '../api-utils';
import {
  initServices,
  syncSlotStatusToD1,
  sanitizeSlot,
  sanitizeSlots,
  getFromCache,
  invalidateCache,
  getSettings,
} from './helpers';

const log = createLogger('[livestream-slots]');

export async function handleCheckStreamKey(
  djId: string,
  settings: Awaited<ReturnType<typeof getSettings>>
): Promise<Response> {
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

export async function handleCurrentLive(
  db: unknown,
  settings: Awaited<ReturnType<typeof getSettings>>
): Promise<Response> {
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

export async function handleCanGoLiveAfter(
  djId: string,
  db: unknown,
  settings: Awaited<ReturnType<typeof getSettings>>
): Promise<Response> {
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

export async function handleHistory(): Promise<Response> {
  // Query with limit to prevent unbounded reads
  const historySlots = await queryCollection('livestreamSlots', {
    skipCache: true,
    filters: [{ field: 'status', op: 'IN', value: ['completed', 'cancelled'] }],
    limit: 100  // Max 100 history items to prevent runaway
  });

  return successResponse({ slots: sanitizeSlots(historySlots) });
}

export async function handleSchedule(
  request: Request,
  db: unknown,
  env: Record<string, unknown>,
  invalidateStatusCacheFn: () => Promise<void>
): Promise<Response> {
  const url = new URL(request.url);
  const startDate = url.searchParams.get('start') || new Date().toISOString();
  const endDate = url.searchParams.get('end') || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const djId = url.searchParams.get('djId');
  const forceRefresh = url.searchParams.get('_t');
  const settings = await getSettings();

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

  // D1 consistency check: if D1 has 'live' slots with expired endTime, verify with Firebase
  const nowCheck = new Date();
  const staleD1Live = allSlots.filter((s: Record<string, unknown>) =>
    s.status === 'live' && s.endTime && new Date(s.endTime as string) < nowCheck
  );
  if (staleD1Live.length > 0) {
    // Fetch all stale slots from Firebase in parallel (avoids N+1 sequential calls)
    const staleResults = await Promise.allSettled(
      staleD1Live.map(stale => getDocument('livestreamSlots', stale.id))
    );
    for (let i = 0; i < staleD1Live.length; i++) {
      const stale = staleD1Live[i];
      const result = staleResults[i];
      if (result.status === 'rejected') {
        log.warn('D1 consistency fix failed for', stale.id, result.reason);
        continue;
      }
      const fbSlot = result.value;
      if (fbSlot && fbSlot.status !== 'live') {
        // D1 is stale — update it and fix the local allSlots array
        stale.status = fbSlot.status;
        if (fbSlot.endedAt) stale.endedAt = fbSlot.endedAt;
        if (fbSlot.autoEnded) stale.autoEnded = fbSlot.autoEnded;
        try {
          await syncSlotStatusToD1(db, stale.id, fbSlot.status as string, {
            endedAt: fbSlot.endedAt as string || nowCheck.toISOString(),
            autoEnded: fbSlot.autoEnded || false
          });
          log.info(`Fixed stale D1 slot ${stale.id}: ${fbSlot.status}`);
        } catch (syncErr: unknown) {
          log.warn('D1 sync failed for stale slot', stale.id, syncErr);
        }
      }
    }
  }

  // Check D1 for live slots to see if auto-end check is needed
  const d1LiveSlots = db ? await d1GetLiveSlots(db) : [];

  // Only check Firebase for auto-end if D1 shows live slots OR randomly (10% of requests for safety)
  const shouldCheckAutoEnd = d1LiveSlots.length > 0 || Math.random() < 0.1;

  if (shouldCheckAutoEnd) {
    await autoEndExpiredSlots(db, env, now, invalidateStatusCacheFn);
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
}

// Auto-end expired live slots — extracted from GET handler
async function autoEndExpiredSlots(
  db: unknown,
  env: Record<string, unknown>,
  now: Date,
  invalidateStatusCacheFn: () => Promise<void>
): Promise<void> {
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
      // Relay streams stay alive until manually ended (unless another DJ needs the slot)
      const isRelayStream = liveSlot.isRelay === true;

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

      // Relay streams: skip auto-end unless another DJ is waiting
      if (isRelayStream && !anotherDjWaiting) {
        // Extend the relay endTime by another 24 hours so it doesn't keep triggering
        const newEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        try {
          await updateDocument('livestreamSlots', liveSlot.id, {
            endTime: newEnd.toISOString(),
            updatedAt: now.toISOString()
          });
          await syncSlotStatusToD1(db, liveSlot.id, 'live', { endTime: newEnd.toISOString() });
        } catch (extErr: unknown) {
          log.warn('Failed to extend relay endTime:', extErr);
        }
        continue;
      }

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
          } catch (evErr: unknown) {
            // If event check fails, give Plus users 4hr default
            maxDurationMs = 4 * 60 * 60 * 1000;
          }
        }
      } catch (userErr: unknown) {
        log.warn('Could not check DJ subscription for auto-end:', userErr);
      }
      const exceededMaxDuration = streamDurationMs >= maxDurationMs;

      // Check if DJ has disconnected (no heartbeat for 3+ minutes after slot end)
      const lastHeartbeat = liveSlot.lastHeartbeat ? new Date(liveSlot.lastHeartbeat as string) : null;
      const timeSinceSlotEnd = now.getTime() - slotEnd.getTime();
      const heartbeatStale = lastHeartbeat
        ? (now.getTime() - lastHeartbeat.getTime() > 3 * 60 * 1000) // No heartbeat for 3 min
        : (timeSinceSlotEnd > 5 * 60 * 1000); // No heartbeat field at all + 5 min past end
      const djDisconnected = heartbeatStale && timeSinceSlotEnd > 2 * 60 * 1000;

      const shouldAutoEnd = anotherDjWaiting || exceededMaxDuration || djDisconnected;

      if (shouldAutoEnd) {
        const reason = anotherDjWaiting ? 'next_dj_waiting' : (exceededMaxDuration ? 'max_duration_reached' : 'dj_disconnected');
        log.info(`Auto-ending slot ${liveSlot.id} for ${liveSlot.djName} (${reason})`);
        try {
          await updateDocument('livestreamSlots', liveSlot.id, {
            status: 'completed',
            endedAt: now.toISOString(),
            updatedAt: now.toISOString(),
            autoEnded: true,
            autoEndReason: reason
          });

          // Sync to D1 (await to ensure D1 is up to date before status checks)
          await syncSlotStatusToD1(db, liveSlot.id, 'completed', {
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
          await invalidateStatusCacheFn();
        } catch (autoEndError: unknown) {
          log.error('Failed to auto-end slot:', autoEndError);
        }
      }
    }
  }
}
