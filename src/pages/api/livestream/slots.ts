// src/pages/api/livestream/slots.ts
// DJ livestream schedule - uses Firebase REST API
import type { APIRoute } from 'astro';
import { queryCollection, getDocument, setDocument, updateDocument } from '../../../lib/firebase-rest';

const SLOT_DURATIONS = [30, 45, 60, 120, 180, 240];
const MAX_BOOKING_DAYS = 30;

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

// Stream key generation
function generateStreamKey(djId: string, slotId: string, startTime: Date): string {
  const hash = `${djId}-${slotId}-${startTime.getTime()}`.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
  return `fw_${hash}_${Date.now().toString(36)}`;
}

function buildRtmpUrl(streamKey: string): string {
  return `rtmp://stream.freshwax.co.uk/live/${streamKey}`;
}

function buildHlsUrl(streamKey: string): string {
  return `https://stream.freshwax.co.uk/hls/${streamKey}/index.m3u8`;
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
export const GET: APIRoute = async ({ request }) => {
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

      return new Response(JSON.stringify({
        success: true,
        isLive: true,
        currentStream: {
          ...liveSlot,
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

    // Default: Get schedule
    const cacheKey = `${startDate}-${endDate}-${djId || 'all'}`;
    let slots = forceRefresh ? null : getFromCache(cacheKey);

    if (!slots) {
      const allSlots = await queryCollection('livestreamSlots', { skipCache: true });
      slots = allSlots.filter(slot => slot.startTime >= startDate && slot.startTime <= endDate);
      if (djId) slots = slots.filter(slot => slot.djId === djId);
      setCache(cacheKey, slots);
    }

    const now = new Date().toISOString();
    const liveSlot = slots.find(slot => slot.startTime <= now && slot.endTime >= now && slot.status === 'live');
    const upcomingSlots = slots.filter(slot => slot.startTime > now && ['scheduled', 'in_lobby', 'queued'].includes(slot.status));

    return new Response(JSON.stringify({
      success: true,
      slots,
      currentLive: liveSlot || null,
      upcoming: upcomingSlots,
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
export const POST: APIRoute = async ({ request }) => {
  try {
    const data = await request.json();
    const { action } = data;
    const now = new Date();
    const nowISO = now.toISOString();

    const settings = await getSettings();

    // BOOK A SLOT
    if (action === 'book') {
      const { djId, djName, djAvatar, startTime, duration, title, genre, description } = data;

      if (!djId || !startTime || !duration || !djName) {
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

      // Check for conflicts
      const existingSlots = await queryCollection('livestreamSlots', { skipCache: true });
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
      const streamKey = generateStreamKey(djId, slotId, slotStart);

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

      await setDocument('livestreamSlots', slotId, newSlot);
      invalidateCache();

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
      const streamKey = generateStreamKey(djId, slotId, now);

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

      await setDocument('livestreamSlots', slotId, newSlot);
      invalidateCache();

      return new Response(JSON.stringify({
        success: true,
        slot: { id: slotId, ...newSlot },
        streamKey,
        rtmpUrl: newSlot.rtmpUrl,
        hlsUrl: newSlot.hlsUrl
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
      });

      invalidateCache();

      return new Response(JSON.stringify({ success: true, message: 'Slot cancelled' }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    // END STREAM
    if (action === 'endStream') {
      const { slotId, djId } = data;

      const slot = await getDocument('livestreamSlots', slotId);

      if (!slot) {
        return new Response(JSON.stringify({ success: false, error: 'Slot not found' }), {
          status: 404, headers: { 'Content-Type': 'application/json' }
        });
      }

      if (slot.djId !== djId && !data.adminEnd) {
        return new Response(JSON.stringify({ success: false, error: 'Not authorized' }), {
          status: 403, headers: { 'Content-Type': 'application/json' }
        });
      }

      await updateDocument('livestreamSlots', slotId, {
        status: 'completed',
        endedAt: nowISO,
        updatedAt: nowISO
      });

      invalidateCache();

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
        serverUrl: 'rtmp://stream.freshwax.co.uk/live',
        slotInfo: {
          id: slotId,
          title: slot.title,
          startTime: slot.startTime,
          endTime: slot.endTime,
          status: slot.status
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ success: false, error: 'Invalid action' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[livestream/slots] POST Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Failed to process request' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
};

// DELETE: Cancel slot
export const DELETE: APIRoute = async ({ request }) => {
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
