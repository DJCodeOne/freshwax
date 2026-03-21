// src/lib/livestream-slots/activation.ts
// Activation handlers: go live, go live now, early start
import { queryCollection, setDocument, updateDocument } from '../firebase-rest';
import { buildRtmpUrl, buildHlsUrl } from '../red5';
import { broadcastLiveStatus } from '../pusher';
import { logActivity } from '../activity-feed';
import { createLogger, ApiErrors, fetchWithTimeout, successResponse } from '../api-utils';
import {
  syncSlotToD1,
  syncSlotStatusToD1,
  checkDjEligible,
  generateStreamKey,
  invalidateCache,
  getSettings,
  generateId,
} from './helpers';

const log = createLogger('[livestream-slots]');

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
