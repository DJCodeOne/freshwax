// src/pages/api/livestream/slots.ts
// Enhanced DJ livestream schedule - booking, viewing, cancelling with timing features
// Features: 15-min key reveal, 3-min grace period, go live after current DJ

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// Try to import Red5 config, fallback to basic key generation if not available
let generateStreamKey: (djId: string, slotId: string, startTime: Date, endTime: Date) => string;
let buildRtmpUrl: (streamKey: string) => string;
let buildHlsUrl: (streamKey: string) => string;
let RED5_CONFIG: any;

try {
  const red5 = await import('../../../lib/red5');
  generateStreamKey = red5.generateStreamKey;
  buildRtmpUrl = red5.buildRtmpUrl;
  buildHlsUrl = red5.buildHlsUrl;
  RED5_CONFIG = red5.RED5_CONFIG;
} catch {
  // Fallback functions if red5 module not available
  generateStreamKey = (djId, slotId, startTime, endTime) => {
    const hash = `${djId}-${slotId}-${startTime.getTime()}`.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
    return `fw_${hash}_${Date.now().toString(36)}`;
  };
  buildRtmpUrl = (streamKey) => `rtmp://stream.freshwax.co.uk/live/${streamKey}`;
  buildHlsUrl = (streamKey) => `https://stream.freshwax.co.uk/hls/${streamKey}/index.m3u8`;
  RED5_CONFIG = { server: { rtmpUrl: 'rtmp://stream.freshwax.co.uk/live' } };
}

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

// Default configuration (can be overridden by admin settings)
const SLOT_DURATIONS = [30, 45, 60, 120, 180, 240];
const MAX_BOOKING_DAYS = 30;

// Get livestream settings from Firebase or use defaults
async function getLivestreamSettings() {
  try {
    const doc = await db.doc('system/admin-settings').get();
    if (doc.exists) {
      return doc.data()?.livestream || {};
    }
  } catch (e) {
    console.warn('[slots] Could not load admin settings:', e);
  }
  return {};
}

// Default settings that can be overridden
const DEFAULT_SETTINGS = {
  defaultDailyHours: 2,
  defaultWeeklySlots: 2,
  streamKeyRevealMinutes: 15,
  gracePeriodMinutes: 3,
  sessionEndCountdown: 10,
  requiredMixes: 1,
  requiredLikes: 10,
  allowBypassRequests: true,
  allowGoLiveNow: true,
  allowGoLiveAfter: true,
  allowTakeover: true
};

// Server-side cache
interface CacheEntry { data: any; timestamp: number; key: string; }
const serverCache: Map<string, CacheEntry> = new Map();
const SERVER_CACHE_TTL = 5000;

function getFromCache(key: string): any | null {
  const entry = serverCache.get(key);
  if (entry && (Date.now() - entry.timestamp) < SERVER_CACHE_TTL) {
    return entry.data;
  }
  if (entry) serverCache.delete(key);
  return null;
}

function setCache(key: string, data: any): void {
  if (serverCache.size > 100) {
    const oldestKey = serverCache.keys().next().value;
    serverCache.delete(oldestKey);
  }
  serverCache.set(key, { data, timestamp: Date.now(), key });
}

function invalidateScheduleCache(): void {
  serverCache.clear();
}

// GET: Fetch schedule slots
export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const startDate = url.searchParams.get('start') || new Date().toISOString();
    const endDate = url.searchParams.get('end') || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const djId = url.searchParams.get('djId');
    const forceRefresh = url.searchParams.get('_t');
    const action = url.searchParams.get('action');
    
    // Get admin settings
    const adminSettings = await getLivestreamSettings();
    const settings = { ...DEFAULT_SETTINGS, ...adminSettings };
    
    // Action: Check stream key availability for a DJ
    if (action === 'checkStreamKey' && djId) {
      const now = new Date();
      const keyRevealTime = new Date(now.getTime() + settings.streamKeyRevealMinutes * 60 * 1000);
      
      // Find DJ's next scheduled slot within key reveal window
      const snapshot = await db.collection('livestreamSlots')
        .where('djId', '==', djId)
        .where('status', 'in', ['scheduled', 'in_lobby'])
        .orderBy('startTime', 'asc')
        .limit(5)
        .get();
      
      let keyAvailable = false;
      let slotInfo = null;
      let timeUntilKey = null;
      let streamKey = null;
      
      for (const doc of snapshot.docs) {
        const slot = doc.data();
        const slotStart = new Date(slot.startTime);
        const slotEnd = new Date(slot.endTime);
        
        // Check if within reveal window (current time + reveal minutes >= start time)
        // Or if within grace period after start
        const graceEnd = new Date(slotStart.getTime() + settings.gracePeriodMinutes * 60 * 1000);
        
        if (now >= new Date(slotStart.getTime() - settings.streamKeyRevealMinutes * 60 * 1000) && now <= graceEnd) {
          keyAvailable = true;
          streamKey = slot.streamKey;
          slotInfo = {
            id: doc.id,
            startTime: slot.startTime,
            endTime: slot.endTime,
            title: slot.title,
            status: slot.status
          };
          break;
        } else if (slotStart > now) {
          // Calculate time until key becomes available
          const keyAvailableAt = new Date(slotStart.getTime() - settings.streamKeyRevealMinutes * 60 * 1000);
          timeUntilKey = Math.max(0, keyAvailableAt.getTime() - now.getTime());
          slotInfo = {
            id: doc.id,
            startTime: slot.startTime,
            endTime: slot.endTime,
            title: slot.title,
            status: slot.status
          };
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
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    }
    
    // Action: Get current live stream with countdown info
    if (action === 'currentLive') {
      const liveSnapshot = await db.collection('livestreamSlots')
        .where('status', '==', 'live')
        .limit(1)
        .get();
      
      if (liveSnapshot.empty) {
        return new Response(JSON.stringify({
          success: true,
          isLive: false,
          currentStream: null
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const liveDoc = liveSnapshot.docs[0];
      const liveData = liveDoc.data();
      const endTime = new Date(liveData.endTime);
      const now = new Date();
      const timeRemaining = Math.max(0, endTime.getTime() - now.getTime());
      
      // Check if within final countdown
      const showCountdown = timeRemaining <= settings.sessionEndCountdown * 1000;
      
      return new Response(JSON.stringify({
        success: true,
        isLive: true,
        currentStream: {
          id: liveDoc.id,
          ...liveData,
          timeRemaining,
          showCountdown,
          countdownSeconds: showCountdown ? Math.ceil(timeRemaining / 1000) : null
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Action: Check if "Go Live After" is available
    if (action === 'canGoLiveAfter' && djId) {
      if (!settings.allowGoLiveAfter) {
        return new Response(JSON.stringify({
          success: true,
          canGoLiveAfter: false,
          reason: 'Feature disabled by admin'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Check if there's a live stream
      const liveSnapshot = await db.collection('livestreamSlots')
        .where('status', '==', 'live')
        .limit(1)
        .get();
      
      if (liveSnapshot.empty) {
        return new Response(JSON.stringify({
          success: true,
          canGoLiveAfter: false,
          reason: 'No active stream'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      
      const currentStream = liveSnapshot.docs[0].data();
      const endTime = new Date(currentStream.endTime);
      
      // Check if slot after current stream is taken
      const nextSlotCheck = await db.collection('livestreamSlots')
        .where('status', 'in', ['scheduled', 'in_lobby', 'queued'])
        .where('startTime', '>=', currentStream.endTime)
        .orderBy('startTime', 'asc')
        .limit(1)
        .get();
      
      // Allow if no next slot or next slot is more than 5 minutes after current ends
      let canGoLiveAfter = true;
      let reason = null;
      
      if (!nextSlotCheck.empty) {
        const nextSlot = nextSlotCheck.docs[0].data();
        const nextStart = new Date(nextSlot.startTime);
        const gap = nextStart.getTime() - endTime.getTime();
        
        if (gap < 5 * 60 * 1000) { // Less than 5 minute gap
          canGoLiveAfter = false;
          reason = `Next slot starts at ${nextStart.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
        }
      }
      
      return new Response(JSON.stringify({
        success: true,
        canGoLiveAfter,
        reason,
        currentStreamEndsAt: currentStream.endTime,
        currentDjName: currentStream.djName
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Default: Get schedule slots
    const cacheKey = `${startDate}-${endDate}-${djId || 'all'}`;
    let slots = forceRefresh ? null : getFromCache(cacheKey);
    
    if (!slots) {
      try {
        const snapshot = await db.collection('livestreamSlots')
          .orderBy('startTime', 'asc')
          .get();
        
        slots = snapshot.docs
          .map(doc => ({ id: doc.id, ...doc.data() }))
          .filter(slot => slot.startTime >= startDate && slot.startTime <= endDate);
        
        if (djId) {
          slots = slots.filter(slot => slot.djId === djId);
        }
        
        // Look up current display names for all DJs in slots
        // This ensures we always show the correct public name (e.g. "Code One" not "Dave Hagon")
        const uniqueDjIds = [...new Set(slots.map(s => s.djId).filter(Boolean))];
        if (uniqueDjIds.length > 0) {
          const djNameMap = new Map();
          const djAvatarMap = new Map();
          
          // Batch fetch user data for all DJs - check multiple collections like get-user-type.ts does
          for (const uid of uniqueDjIds) {
            try {
              // Check users collection first
              const userDoc = await db.collection('users').doc(uid).get();
              if (userDoc.exists) {
                const userData = userDoc.data();
                // displayName is the public/artist name (same as Header.astro uses from Firebase Auth)
                if (userData?.displayName) {
                  djNameMap.set(uid, userData.displayName);
                }
                // Check avatarUrl and photoURL fields
                const avatar = userData?.avatarUrl || userData?.photoURL;
                if (avatar) {
                  djAvatarMap.set(uid, avatar);
                }
              }
              
              // Also check artists collection (like get-user-type.ts does)
              const artistDoc = await db.collection('artists').doc(uid).get();
              if (artistDoc.exists) {
                const artistData = artistDoc.data();
                // artistName takes priority if set
                if (artistData?.artistName && !djNameMap.has(uid)) {
                  djNameMap.set(uid, artistData.artistName);
                }
                // Check avatar fields - imageUrl is common in artists collection
                if (!djAvatarMap.has(uid)) {
                  const artistAvatar = artistData?.avatarUrl || artistData?.photoURL || artistData?.imageUrl;
                  if (artistAvatar) {
                    djAvatarMap.set(uid, artistAvatar);
                  }
                }
              }
            } catch (e) {
              // Skip if user lookup fails
            }
          }
          
          // Update slots with current display names and avatars
          slots = slots.map(slot => ({
            ...slot,
            djName: djNameMap.get(slot.djId) || slot.djName,
            djAvatar: djAvatarMap.get(slot.djId) || slot.djAvatar
          }));
        }
        
        setCache(cacheKey, slots);
      } catch (queryError: any) {
        console.warn('[livestream/slots] Query error:', queryError.message);
        slots = [];
      }
    }
    
    const now = new Date().toISOString();
    const liveSlot = slots.find(slot => 
      slot.startTime <= now && 
      slot.endTime >= now && 
      slot.status === 'live'
    );
    
    const upcomingSlots = slots.filter(slot => 
      slot.startTime > now && 
      ['scheduled', 'in_lobby', 'queued'].includes(slot.status)
    );
    
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
    }), { 
      status: 200, 
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } 
    });
    
  } catch (error) {
    console.error('[livestream/slots] GET Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch schedule'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// POST: Book, cancel, go live, takeover, etc.
export const POST: APIRoute = async ({ request }) => {
  try {
    const data = await request.json();
    const { action } = data;
    const now = new Date();
    const nowISO = now.toISOString();
    
    // Get admin settings
    const adminSettings = await getLivestreamSettings();
    const settings = { ...DEFAULT_SETTINGS, ...adminSettings };
    
    // BOOK A SLOT
    if (action === 'book') {
      const { djId, djName, djAvatar, crew, representing, startTime, duration, title, genre, description } = data;
      
      if (!djId || !startTime || !duration) {
        return new Response(JSON.stringify({
          success: false,
          error: 'DJ ID, start time, and duration required'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      if (!djName || djName.trim() === '') {
        return new Response(JSON.stringify({
          success: false,
          error: 'DJ name is required'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      if (!SLOT_DURATIONS.includes(duration)) {
        return new Response(JSON.stringify({
          success: false,
          error: `Duration must be one of: ${SLOT_DURATIONS.join(', ')} minutes`
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      const slotStart = new Date(startTime);
      const slotEnd = new Date(slotStart.getTime() + duration * 60 * 1000);
      
      if (slotStart.getTime() < now.getTime()) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Cannot book a slot in the past'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      const maxDate = new Date(now.getTime() + MAX_BOOKING_DAYS * 24 * 60 * 60 * 1000);
      if (slotStart > maxDate) {
        return new Response(JSON.stringify({
          success: false,
          error: `Cannot book more than ${MAX_BOOKING_DAYS} days in advance`
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Check for conflicts
      const conflictQuery = await db.collection('livestreamSlots')
        .where('status', 'in', ['scheduled', 'in_lobby', 'live', 'queued'])
        .get();
      
      const conflicts = conflictQuery.docs.filter(doc => {
        const slot = doc.data();
        const existingStart = new Date(slot.startTime);
        const existingEnd = new Date(slot.endTime);
        return (slotStart < existingEnd && slotEnd > existingStart);
      });
      
      if (conflicts.length > 0) {
        const conflictSlot = conflicts[0].data();
        return new Response(JSON.stringify({
          success: false,
          error: `Time conflicts with ${conflictSlot.djName}'s booking`
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Check DJ's allowance
      const allowanceDoc = await db.collection('djAllowances').doc(djId).get();
      const allowance = allowanceDoc.exists ? allowanceDoc.data() : null;
      const weeklySlots = allowance?.weeklySlots || settings.defaultWeeklySlots;
      const maxHoursPerDay = allowance?.maxHoursPerDay || settings.defaultDailyHours;
      
      // Check daily hours limit
      const dayStart = new Date(slotStart);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      
      const dayBookings = await db.collection('livestreamSlots')
        .where('djId', '==', djId)
        .where('status', 'in', ['scheduled', 'in_lobby', 'live', 'completed'])
        .where('startTime', '>=', dayStart.toISOString())
        .where('startTime', '<', dayEnd.toISOString())
        .get();
      
      const hoursBookedToday = dayBookings.docs.reduce((sum, doc) => {
        return sum + ((doc.data().duration || 60) / 60);
      }, 0);
      
      const requestedHours = duration / 60;
      if (hoursBookedToday + requestedHours > maxHoursPerDay) {
        return new Response(JSON.stringify({
          success: false,
          error: `Maximum ${maxHoursPerDay} hours per day. You have ${hoursBookedToday.toFixed(1)} hours booked.`
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Check weekly slots limit
      const weekStart = new Date(slotStart);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay() + (weekStart.getDay() === 0 ? -6 : 1));
      weekStart.setHours(0, 0, 0, 0);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);
      
      const weekBookings = await db.collection('livestreamSlots')
        .where('djId', '==', djId)
        .where('status', 'in', ['scheduled', 'in_lobby', 'live', 'completed'])
        .where('startTime', '>=', weekStart.toISOString())
        .where('startTime', '<', weekEnd.toISOString())
        .get();
      
      if (weekBookings.size >= weeklySlots) {
        return new Response(JSON.stringify({
          success: false,
          error: `You can only book ${weeklySlots} slot${weeklySlots > 1 ? 's' : ''} per week.`
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Create slot
      const tempSlotId = db.collection('livestreamSlots').doc().id;
      const streamKey = generateStreamKey(djId, tempSlotId, slotStart, slotEnd);
      const rtmpUrl = buildRtmpUrl(streamKey);
      const hlsUrl = buildHlsUrl(streamKey);
      
      const newSlot = {
        djId,
        djName: djName.trim(),
        djAvatar: djAvatar || null,
        crew: crew || null,
        representing: representing || null,
        title: title || `${djName.trim()} Live`,
        genre: genre || 'Jungle / D&B',
        description: description || '',
        startTime: slotStart.toISOString(),
        endTime: slotEnd.toISOString(),
        duration,
        status: 'scheduled',
        streamKey,
        rtmpUrl,
        hlsUrl,
        streamSource: 'red5',
        createdAt: nowISO,
        updatedAt: nowISO,
        viewerPeak: 0,
        totalViews: 0,
        currentViewers: 0,
      };
      
      await db.collection('livestreamSlots').doc(tempSlotId).set(newSlot);
      invalidateScheduleCache();
      
      return new Response(JSON.stringify({
        success: true,
        slot: { id: tempSlotId, ...newSlot },
        streamKey,
        message: 'Slot booked successfully'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    
    // GO LIVE NOW
    if (action === 'go_live_now') {
      if (!settings.allowGoLiveNow) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Go Live Now is currently disabled'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      const { djId, djName, djAvatar, title, genre, description } = data;
      
      if (!djId || !djName) {
        return new Response(JSON.stringify({
          success: false,
          error: 'DJ ID and name required'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Check if anyone is live
      const liveCheck = await db.collection('livestreamSlots')
        .where('status', '==', 'live')
        .limit(1)
        .get();
      
      if (!liveCheck.empty) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Someone is already streaming'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Check for upcoming slots within 5 minutes
      const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
      const upcomingCheck = await db.collection('livestreamSlots')
        .where('status', 'in', ['scheduled', 'in_lobby'])
        .where('startTime', '<=', fiveMinutesFromNow)
        .limit(1)
        .get();
      
      if (!upcomingCheck.empty) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Another DJ is about to go live'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Calculate end time - top of next hour
      const endTime = new Date(now);
      endTime.setMinutes(0, 0, 0);
      endTime.setHours(endTime.getHours() + 1);
      if (now.getMinutes() >= 55) {
        endTime.setHours(endTime.getHours() + 1);
      }
      
      const tempSlotId = db.collection('livestreamSlots').doc().id;
      const streamKey = generateStreamKey(djId, tempSlotId, now, endTime);
      const rtmpUrl = buildRtmpUrl(streamKey);
      const hlsUrl = buildHlsUrl(streamKey);
      
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
        rtmpUrl,
        hlsUrl,
        status: 'live',
        createdAt: nowISO,
        startedAt: nowISO,
        viewerPeak: 0,
        totalViews: 0,
        currentViewers: 0,
      };
      
      await db.collection('livestreamSlots').doc(tempSlotId).set(newSlot);
      invalidateScheduleCache();
      
      return new Response(JSON.stringify({
        success: true,
        slot: { id: tempSlotId, ...newSlot },
        streamKey,
        rtmpUrl,
        hlsUrl
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    
    // GO LIVE AFTER CURRENT DJ
    if (action === 'go_live_after') {
      if (!settings.allowGoLiveAfter) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Go Live After is currently disabled'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      const { djId, djName, djAvatar, duration, title, genre, description } = data;
      const requestedDuration = duration || 60; // Default 1 hour
      
      if (!djId || !djName) {
        return new Response(JSON.stringify({
          success: false,
          error: 'DJ ID and name required'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Get current live stream
      const liveCheck = await db.collection('livestreamSlots')
        .where('status', '==', 'live')
        .limit(1)
        .get();
      
      if (liveCheck.empty) {
        return new Response(JSON.stringify({
          success: false,
          error: 'No active stream to follow'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      const currentStream = liveCheck.docs[0].data();
      const currentEndTime = new Date(currentStream.endTime);
      
      // Check if slot after is available
      const nextCheck = await db.collection('livestreamSlots')
        .where('status', 'in', ['scheduled', 'in_lobby', 'queued'])
        .where('startTime', '>=', currentStream.endTime)
        .orderBy('startTime', 'asc')
        .limit(1)
        .get();
      
      if (!nextCheck.empty) {
        const nextSlot = nextCheck.docs[0].data();
        const nextStart = new Date(nextSlot.startTime);
        const gap = nextStart.getTime() - currentEndTime.getTime();
        
        if (gap < 5 * 60 * 1000) {
          return new Response(JSON.stringify({
            success: false,
            error: `Next slot is booked by ${nextSlot.djName}`
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
      }
      
      // Create queued slot
      const slotStart = currentEndTime;
      const slotEnd = new Date(slotStart.getTime() + requestedDuration * 60 * 1000);
      
      const tempSlotId = db.collection('livestreamSlots').doc().id;
      const streamKey = generateStreamKey(djId, tempSlotId, slotStart, slotEnd);
      const rtmpUrl = buildRtmpUrl(streamKey);
      const hlsUrl = buildHlsUrl(streamKey);
      
      const newSlot = {
        djId,
        djName: djName.trim(),
        djAvatar: djAvatar || null,
        startTime: slotStart.toISOString(),
        endTime: slotEnd.toISOString(),
        duration: requestedDuration,
        title: title || `${djName.trim()} Live`,
        genre: genre || 'Jungle / D&B',
        description: description || '',
        streamKey,
        rtmpUrl,
        hlsUrl,
        status: 'queued', // Queued to go live after current
        queuedAfter: liveCheck.docs[0].id,
        createdAt: nowISO,
        viewerPeak: 0,
        totalViews: 0,
        currentViewers: 0,
      };
      
      await db.collection('livestreamSlots').doc(tempSlotId).set(newSlot);
      invalidateScheduleCache();
      
      return new Response(JSON.stringify({
        success: true,
        slot: { id: tempSlotId, ...newSlot },
        streamKey,
        message: `You're queued after ${currentStream.djName}. Your stream key will be available 15 minutes before.`
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    
    // CANCEL SLOT
    if (action === 'cancel') {
      const { slotId, djId } = data;
      
      if (!slotId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Slot ID required'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      const slotRef = db.collection('livestreamSlots').doc(slotId);
      const slotDoc = await slotRef.get();
      
      if (!slotDoc.exists) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Slot not found'
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      
      const slot = slotDoc.data()!;
      
      // Only owner or admin can cancel
      if (slot.djId !== djId && !data.adminCancel) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Not authorized to cancel this slot'
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      
      await slotRef.update({
        status: 'cancelled',
        cancelledAt: nowISO,
        updatedAt: nowISO
      });
      
      invalidateScheduleCache();
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Slot cancelled'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    
    // END STREAM
    if (action === 'endStream') {
      const { slotId, djId } = data;
      
      const slotRef = db.collection('livestreamSlots').doc(slotId);
      const slotDoc = await slotRef.get();
      
      if (!slotDoc.exists) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Slot not found'
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      
      const slot = slotDoc.data()!;
      
      if (slot.djId !== djId && !data.adminEnd) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Not authorized'
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      
      await slotRef.update({
        status: 'completed',
        endedAt: nowISO,
        updatedAt: nowISO
      });
      
      // Check if there's a queued slot
      const queuedCheck = await db.collection('livestreamSlots')
        .where('status', '==', 'queued')
        .where('queuedAfter', '==', slotId)
        .limit(1)
        .get();
      
      if (!queuedCheck.empty) {
        // Transition queued slot to live
        await queuedCheck.docs[0].ref.update({
          status: 'live',
          startedAt: nowISO,
          startTime: nowISO,
          updatedAt: nowISO
        });
      }
      
      invalidateScheduleCache();
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Stream ended'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    
    // REQUEST TAKEOVER
    if (action === 'requestTakeover') {
      if (!settings.allowTakeover) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Takeover is currently disabled'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      const { slotId, requesterId, requesterName, requesterAvatar } = data;
      
      if (!slotId || !requesterId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Slot ID and requester ID required'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      const slotRef = db.collection('livestreamSlots').doc(slotId);
      const slotDoc = await slotRef.get();
      
      if (!slotDoc.exists || slotDoc.data()?.status !== 'live') {
        return new Response(JSON.stringify({
          success: false,
          error: 'No active stream to take over'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      await slotRef.update({
        takeoverRequest: {
          requesterId,
          requesterName,
          requesterAvatar,
          status: 'pending',
          requestedAt: nowISO
        },
        updatedAt: nowISO
      });
      
      invalidateScheduleCache();
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Takeover request sent'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    
    // APPROVE TAKEOVER
    if (action === 'approveTakeover') {
      const { slotId, djId } = data;
      
      const slotRef = db.collection('livestreamSlots').doc(slotId);
      const slotDoc = await slotRef.get();
      
      if (!slotDoc.exists) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Slot not found'
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      
      const slot = slotDoc.data()!;
      
      if (slot.djId !== djId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Only current DJ can approve'
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      
      if (!slot.takeoverRequest || slot.takeoverRequest.status !== 'pending') {
        return new Response(JSON.stringify({
          success: false,
          error: 'No pending takeover request'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      const takeoverRequest = slot.takeoverRequest;
      
      // Transfer to new DJ
      await slotRef.update({
        djId: takeoverRequest.requesterId,
        djName: takeoverRequest.requesterName,
        djAvatar: takeoverRequest.requesterAvatar,
        takeoverRequest: {
          ...takeoverRequest,
          status: 'approved',
          approvedAt: nowISO
        },
        takeoverHistory: FieldValue.arrayUnion({
          originalDjId: slot.djId,
          originalDjName: slot.djName,
          newDjId: takeoverRequest.requesterId,
          newDjName: takeoverRequest.requesterName,
          takenOverAt: nowISO
        }),
        updatedAt: nowISO
      });
      
      invalidateScheduleCache();
      
      return new Response(JSON.stringify({
        success: true,
        streamKey: slot.streamKey,
        message: 'Takeover approved'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    
    // DENY TAKEOVER
    if (action === 'denyTakeover') {
      const { slotId, djId } = data;
      
      const slotRef = db.collection('livestreamSlots').doc(slotId);
      const slotDoc = await slotRef.get();
      
      if (!slotDoc.exists) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Slot not found'
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      
      const slot = slotDoc.data()!;
      
      if (slot.djId !== djId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Only current DJ can deny'
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      
      await slotRef.update({
        takeoverRequest: {
          ...slot.takeoverRequest,
          status: 'denied',
          deniedAt: nowISO
        },
        updatedAt: nowISO
      });
      
      invalidateScheduleCache();
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Takeover denied'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    
    // GET STREAM KEY (for DJ who owns the slot)
    if (action === 'getStreamKey') {
      const { slotId, djId } = data;
      
      if (!slotId || !djId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Slot ID and DJ ID required'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      const slotDoc = await db.collection('livestreamSlots').doc(slotId).get();
      
      if (!slotDoc.exists) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Slot not found'
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      
      const slot = slotDoc.data()!;
      
      if (slot.djId !== djId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Not authorized'
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Check if within key reveal window
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
        return new Response(JSON.stringify({
          success: false,
          error: 'Grace period expired. Stream key is no longer valid.'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      return new Response(JSON.stringify({
        success: true,
        streamKey: slot.streamKey,
        rtmpUrl: slot.rtmpUrl || buildRtmpUrl(slot.streamKey),
        hlsUrl: slot.hlsUrl || buildHlsUrl(slot.streamKey),
        serverUrl: RED5_CONFIG?.server?.rtmpUrl || 'rtmp://stream.freshwax.co.uk/live',
        slotInfo: {
          id: slotId,
          title: slot.title,
          startTime: slot.startTime,
          endTime: slot.endTime,
          status: slot.status
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    
    return new Response(JSON.stringify({
      success: false,
      error: 'Invalid action'
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    
  } catch (error) {
    console.error('[livestream/slots] POST Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to process request'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// DELETE: Cancel slot (for admin use)
export const DELETE: APIRoute = async ({ request }) => {
  try {
    const data = await request.json();
    const { slotId, adminCancel } = data;
    
    if (!slotId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Slot ID required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    const slotRef = db.collection('livestreamSlots').doc(slotId);
    const slotDoc = await slotRef.get();
    
    if (!slotDoc.exists) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Slot not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    
    await slotRef.update({
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      cancelledByAdmin: adminCancel || false
    });
    
    invalidateScheduleCache();
    
    return new Response(JSON.stringify({
      success: true,
      message: 'Slot cancelled'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    
  } catch (error) {
    console.error('[livestream/slots] DELETE Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to cancel slot'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
