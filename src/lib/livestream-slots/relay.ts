// src/lib/livestream-slots/relay.ts
// Relay handler: start relay stream
import { queryCollection, setDocument } from '../firebase-rest';
import { buildRtmpUrl } from '../red5';
import { broadcastLiveStatus } from '../pusher';
import { APPROVED_RELAY_STATIONS } from '../relay-stations';
import { isAdmin } from '../admin';
import { ApiErrors, successResponse } from '../api-utils';
import {
  syncSlotToD1,
  invalidateCache,
  generateId,
} from './helpers';

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
