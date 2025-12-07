// src/pages/api/livestream/slots.ts
// Manage DJ livestream schedule slots - booking, viewing, cancelling

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { generateStreamKey, buildRtmpUrl, buildHlsUrl, RED5_CONFIG } from '../../../lib/red5';

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

// Slot duration options in minutes
const SLOT_DURATIONS = [30, 45, 60, 120, 180, 240];
const MIN_BOOKING_NOTICE = 0; // Allow same-day booking
const MAX_BOOKING_DAYS = 14; // Can book up to 14 days ahead

// Server-side memory cache to reduce Firebase reads
// All concurrent users share this cache - max 1 read per minute
interface CacheEntry {
  data: any;
  timestamp: number;
  key: string;
}

const serverCache: Map<string, CacheEntry> = new Map();
// NOTE: On serverless platforms (Cloudflare Workers, etc), each instance has its own cache.
// Keep TTL very short to avoid stale data across instances.
const SERVER_CACHE_TTL = 5000; // 5 seconds - short TTL for serverless environments

// Listeners tracking - stored in memory (no Firebase reads)
interface Listener {
  id: string;
  name: string;
  avatar: string | null;
  lastSeen: number;
}

const activeListeners: Map<string, Listener> = new Map();
const LISTENER_TIMEOUT = 120000; // 2 minutes - remove if no heartbeat

function cleanupInactiveListeners(): void {
  const now = Date.now();
  for (const [id, listener] of activeListeners) {
    if (now - listener.lastSeen > LISTENER_TIMEOUT) {
      activeListeners.delete(id);
    }
  }
}

function getActiveListeners(): Listener[] {
  cleanupInactiveListeners();
  return Array.from(activeListeners.values())
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, 20); // Max 20 displayed
}

function getCacheKey(startDate: string, endDate: string, djId?: string): string {
  return `${startDate}-${endDate}-${djId || 'all'}`;
}

function getFromCache(key: string): any | null {
  const entry = serverCache.get(key);
  if (entry && (Date.now() - entry.timestamp) < SERVER_CACHE_TTL) {
    return entry.data;
  }
  // Clear expired entry
  if (entry) serverCache.delete(key);
  return null;
}

function setCache(key: string, data: any): void {
  // Limit cache size to prevent memory issues
  if (serverCache.size > 100) {
    // Clear oldest entries
    const oldestKey = serverCache.keys().next().value;
    serverCache.delete(oldestKey);
  }
  serverCache.set(key, { data, timestamp: Date.now(), key });
}

// Invalidate cache when data changes (called after booking/cancelling)
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
    const forceRefresh = url.searchParams.get('_t'); // Cache buster timestamp
    
    // Generate cache key
    const cacheKey = getCacheKey(startDate, endDate, djId || undefined);
    
    // Check server cache first (skip if force refresh requested)
    let slots = forceRefresh ? null : getFromCache(cacheKey);
    
    if (!slots) {
      // Cache miss or force refresh - fetch from Firebase
      let query = db.collection('livestreamSlots')
        .where('startTime', '>=', startDate)
        .where('startTime', '<=', endDate)
        .orderBy('startTime', 'asc');
      
      const snapshot = await query.get();
      
      slots = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      
      // Filter by DJ if specified
      if (djId) {
        slots = slots.filter(slot => slot.djId === djId);
      }
      
      // Store in cache
      setCache(cacheKey, slots);
    }
    
    // Always recalculate live/upcoming from current time (not cached)
    const now = new Date().toISOString();
    const liveSlot = slots.find(slot => 
      slot.startTime <= now && 
      slot.endTime >= now && 
      slot.status === 'live'
    );
    
    // Get next upcoming slots
    const upcomingSlots = slots.filter(slot => 
      slot.startTime > now && 
      (slot.status === 'scheduled' || slot.status === 'in_lobby' || slot.status === 'queued')
    );
    
    return new Response(JSON.stringify({
      success: true,
      slots,
      currentLive: liveSlot || null,
      upcoming: upcomingSlots,
      listeners: getActiveListeners(),
      total: slots.length,
      fresh: !getFromCache(cacheKey) // True if data came from Firebase
    }), { 
      status: 200, 
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate' // Prevent browser/CDN caching
      } 
    });
    
  } catch (error) {
    console.error('[livestream/slots] GET Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch schedule'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// POST: Book a slot, cancel, or update status
export const POST: APIRoute = async ({ request }) => {
  try {
    const data = await request.json();
    const { action } = data;
    const now = new Date();
    const nowISO = now.toISOString();
    
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
      
      // Validate duration
      if (!SLOT_DURATIONS.includes(duration)) {
        return new Response(JSON.stringify({
          success: false,
          error: `Duration must be one of: ${SLOT_DURATIONS.join(', ')} minutes`
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      const slotStart = new Date(startTime);
      const slotEnd = new Date(slotStart.getTime() + duration * 60 * 1000);
      
      // Validate booking time - must be in the future
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
      
      // Check for conflicts (overlapping slots)
      const conflictQuery = await db.collection('livestreamSlots')
        .where('status', 'in', ['scheduled', 'in_lobby', 'live', 'queued'])
        .get();
      
      const conflicts = conflictQuery.docs.filter(doc => {
        const slot = doc.data();
        const existingStart = new Date(slot.startTime);
        const existingEnd = new Date(slot.endTime);
        
        // Check if times overlap
        return (slotStart < existingEnd && slotEnd > existingStart);
      });
      
      if (conflicts.length > 0) {
        const conflictSlot = conflicts[0].data();
        return new Response(JSON.stringify({
          success: false,
          error: `Time slot conflicts with ${conflictSlot.djName}'s booking (${new Date(conflictSlot.startTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} - ${new Date(conflictSlot.endTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })})`
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Check DJ doesn't have too many bookings
      const djBookings = await db.collection('livestreamSlots')
        .where('djId', '==', djId)
        .where('status', 'in', ['scheduled', 'in_lobby'])
        .where('startTime', '>=', nowISO)
        .get();
      
      if (djBookings.size >= 3) {
        return new Response(JSON.stringify({
          success: false,
          error: 'You can only have 3 upcoming bookings at a time'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Generate a temporary slot ID for stream key generation
      const tempSlotId = db.collection('livestreamSlots').doc().id;
      
      // Generate time-based secure stream key using Red5 library
      const streamKey = generateStreamKey(djId, tempSlotId, slotStart, slotEnd);
      
      // Build streaming URLs
      const rtmpUrl = buildRtmpUrl(streamKey);
      const hlsUrl = buildHlsUrl(streamKey);
      
      // Create the slot
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
        status: 'scheduled', // scheduled -> in_lobby -> live -> completed
        streamKey,
        rtmpUrl,
        hlsUrl,
        streamSource: 'red5',
        createdAt: nowISO,
        updatedAt: nowISO,
        lobbyJoinedAt: null,
        wentLiveAt: null,
        endedAt: null,
        viewerPeak: 0,
        totalViews: 0,
        currentViewers: 0,
      };
      
      // Use the pre-generated ID
      const docRef = db.collection('livestreamSlots').doc(tempSlotId);
      await docRef.set(newSlot);
      
      // Invalidate server cache so all users see new booking
      invalidateScheduleCache();
      
      return new Response(JSON.stringify({
        success: true,
        slot: { id: tempSlotId, ...newSlot },
        streamKey,
        rtmpUrl,
        hlsUrl,
        serverUrl: RED5_CONFIG.server.rtmpUrl,
        message: 'Slot booked successfully'
      }), { 
        status: 200, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    // GO LIVE NOW - instant live if no one is streaming
    if (action === 'go_live_now') {
      const { djId, djName, djAvatar, crew, representing, description } = data;
      
      if (!djId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Must be logged in to go live'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      if (!djName || djName.trim() === '') {
        return new Response(JSON.stringify({
          success: false,
          error: 'DJ name is required'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Check if anyone is currently live
      const liveCheck = await db.collection('livestreamSlots')
        .where('status', '==', 'live')
        .limit(1)
        .get();
      
      if (!liveCheck.empty) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Someone is already streaming. Please wait or book a slot for later.'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Check if there's an upcoming slot within 5 minutes
      const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
      const upcomingCheck = await db.collection('livestreamSlots')
        .where('status', 'in', ['scheduled', 'in_lobby'])
        .where('startTime', '<=', fiveMinutesFromNow)
        .limit(1)
        .get();
      
      if (!upcomingCheck.empty) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Another DJ is about to go live. Please wait or book a later slot.'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Calculate end time - top of the next hour
      const endTime = new Date(now);
      endTime.setMinutes(0, 0, 0);
      endTime.setHours(endTime.getHours() + 1);
      
      // If we're already past :55, go to the hour after that
      if (now.getMinutes() >= 55) {
        endTime.setHours(endTime.getHours() + 1);
      }
      
      // Generate a slot ID first for stream key generation
      const tempSlotId = db.collection('livestreamSlots').doc().id;
      
      // Generate time-based secure stream key using Red5 library
      const streamKey = generateStreamKey(djId, tempSlotId, now, endTime);
      
      // Build streaming URLs
      const rtmpUrl = buildRtmpUrl(streamKey);
      const hlsUrl = buildHlsUrl(streamKey);
      
      // Format end time for display (e.g., "16:00")
      const endTimeFormatted = endTime.toLocaleTimeString('en-GB', { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: false 
      });
      
      const newSlot = {
        djId,
        djName: djName.trim(),
        djAvatar: djAvatar || null,
        crew: crew || null,
        representing: representing || null,
        startTime: nowISO,
        endTime: endTime.toISOString(),
        duration: Math.round((endTime.getTime() - now.getTime()) / 60000),
        title: `${djName.trim()} - Live Now`,
        genre: 'Jungle / D&B',
        description: description || null,
        streamKey,
        rtmpUrl,
        hlsUrl,
        streamSource: 'red5',
        status: 'live', // Immediately live
        createdAt: nowISO,
        isLive: true,
        startedAt: nowISO,
        endedAt: null,
        viewerPeak: 0,
        totalViews: 0,
        currentViewers: 0,
      };
      
      const docRef = db.collection('livestreamSlots').doc(tempSlotId);
      await docRef.set(newSlot);
      
      // Invalidate server cache so all users see live status
      invalidateScheduleCache();
      
      return new Response(JSON.stringify({
        success: true,
        slot: { id: tempSlotId, ...newSlot },
        streamKey,
        rtmpUrl,
        hlsUrl,
        serverUrl: RED5_CONFIG.server.rtmpUrl,
        endTime: endTime.toISOString(),
        endTimeFormatted,
        message: `You are now live! Stream ends at ${endTimeFormatted}`
      }), { 
        status: 200, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    // QUEUE - Play after next DJ
    if (action === 'queue') {
      const { djId, djName, djAvatar, crew, representing, description, duration } = data;
      
      if (!djId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Must be logged in to join queue'
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
      
      // Find the latest ending slot (live, in_lobby, scheduled, or queued)
      const activeSlots = await db.collection('livestreamSlots')
        .where('status', 'in', ['live', 'in_lobby', 'scheduled', 'queued'])
        .orderBy('endTime', 'desc')
        .limit(1)
        .get();
      
      let queueStartTime;
      
      if (activeSlots.empty) {
        // No active slots - start in 5 minutes
        queueStartTime = new Date(now.getTime() + 5 * 60 * 1000);
      } else {
        // Start after the last slot ends
        const lastSlot = activeSlots.docs[0].data();
        queueStartTime = new Date(lastSlot.endTime);
        
        // Add 1 minute buffer between sets
        queueStartTime = new Date(queueStartTime.getTime() + 60 * 1000);
      }
      
      const queueEndTime = new Date(queueStartTime.getTime() + duration * 60 * 1000);
      
      // Generate stream key
      const streamKey = 'fw_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
      
      const newSlot = {
        djId,
        djName: djName.trim(),
        djAvatar: djAvatar || null,
        crew: crew || null,
        representing: representing || null,
        startTime: queueStartTime.toISOString(),
        endTime: queueEndTime.toISOString(),
        duration,
        title: `${djName.trim()} - Queued`,
        genre: 'Jungle / D&B',
        description: description || null,
        streamKey,
        status: 'queued',
        createdAt: nowISO,
        isLive: false,
        startedAt: null,
        endedAt: null,
        viewerPeak: 0,
        totalViews: 0
      };
      
      const docRef = await db.collection('livestreamSlots').add(newSlot);
      
      // Invalidate server cache so all users see queue update
      invalidateScheduleCache();
      
      // Format start time for display
      const startTimeFormatted = queueStartTime.toLocaleTimeString('en-GB', { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: false 
      });
      
      return new Response(JSON.stringify({
        success: true,
        slot: { id: docRef.id, ...newSlot },
        streamKey,
        startTime: queueStartTime.toISOString(),
        startTimeFormatted,
        message: `You're in the queue! Estimated start time: ${startTimeFormatted}`
      }), { 
        status: 200, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    // CANCEL A SLOT
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
      
      const slot = slotDoc.data();
      
      // Only the DJ or admin can cancel
      if (slot.djId !== djId && !data.isAdmin) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Not authorized to cancel this slot'
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Can't cancel if already live
      if (slot.status === 'live') {
        return new Response(JSON.stringify({
          success: false,
          error: 'Cannot cancel a live stream'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      await slotRef.update({
        status: 'cancelled',
        cancelledAt: nowISO,
        updatedAt: nowISO
      });
      
      // Invalidate server cache so all users see cancellation
      invalidateScheduleCache();
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Slot cancelled'
      }), { 
        status: 200, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    // JOIN LOBBY (DJ is ready to go live)
    if (action === 'joinLobby') {
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
      
      const slot = slotDoc.data();
      
      if (slot.djId !== djId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Not your slot'
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Can only join lobby 10 minutes before start time
      const slotStart = new Date(slot.startTime);
      const earlyJoinWindow = 10 * 60 * 1000; // 10 minutes
      
      if (now.getTime() < slotStart.getTime() - earlyJoinWindow) {
        const minutesUntilLobby = Math.ceil((slotStart.getTime() - earlyJoinWindow - now.getTime()) / 60000);
        return new Response(JSON.stringify({
          success: false,
          error: `Lobby opens ${minutesUntilLobby} minute(s) before your slot`
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      await slotRef.update({
        status: 'in_lobby',
        lobbyJoinedAt: nowISO,
        updatedAt: nowISO
      });
      
      // Invalidate server cache so all users see lobby status
      invalidateScheduleCache();
      
      return new Response(JSON.stringify({
        success: true,
        slot: { id: slotId, ...slot, status: 'in_lobby', lobbyJoinedAt: nowISO },
        streamKey: slot.streamKey,
        message: 'You are now in the lobby. Your stream will go live when your slot starts.'
      }), { 
        status: 200, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    // GO LIVE (automatic or manual at slot time)
    if (action === 'goLive') {
      const { slotId, djId, isAdmin } = data;
      
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
      
      const slot = slotDoc.data();
      
      // Check if DJ is in lobby
      if (slot.status !== 'in_lobby' && !isAdmin) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Must be in lobby before going live'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Check if another stream is currently live
      const liveQuery = await db.collection('livestreamSlots')
        .where('status', '==', 'live')
        .get();
      
      if (!liveQuery.empty) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Another DJ is currently live. Please wait for their slot to end.'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      await slotRef.update({
        status: 'live',
        wentLiveAt: nowISO,
        updatedAt: nowISO
      });
      
      // Update active stream in livestreams collection
      await db.collection('livestreams').doc('active').set({
        isLive: true,
        currentSlotId: slotId,
        djId: slot.djId,
        djName: slot.djName,
        djAvatar: slot.djAvatar,
        title: slot.title,
        genre: slot.genre,
        description: slot.description,
        startedAt: nowISO,
        scheduledEndTime: slot.endTime,
        streamKey: slot.streamKey
      });
      
      // Invalidate server cache so all users see live status immediately
      invalidateScheduleCache();
      
      return new Response(JSON.stringify({
        success: true,
        message: 'You are now LIVE!',
        slot: { id: slotId, ...slot, status: 'live', wentLiveAt: nowISO }
      }), { 
        status: 200, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    // END STREAM
    if (action === 'endStream') {
      let { slotId, djId, isAdmin } = data;
      
      // If no slotId provided, find the current live slot for this DJ
      if (!slotId && djId) {
        const liveSlotQuery = await db.collection('livestreamSlots')
          .where('djId', '==', djId)
          .where('status', '==', 'live')
          .limit(1)
          .get();
        
        if (!liveSlotQuery.empty) {
          slotId = liveSlotQuery.docs[0].id;
        }
      }
      
      // Also check the livestreams collection for active stream
      if (!slotId) {
        const activeStream = await db.collection('livestreams')
          .where('isLive', '==', true)
          .where('djId', '==', djId)
          .limit(1)
          .get();
        
        if (!activeStream.empty) {
          // End the livestream directly
          const streamDoc = activeStream.docs[0];
          await streamDoc.ref.update({
            isLive: false,
            endedAt: nowISO
          });
          
          // Also update active document
          await db.collection('livestreams').doc('active').set({
            isLive: false,
            currentSlotId: null,
            endedAt: nowISO
          });
          
          invalidateScheduleCache();
          
          return new Response(JSON.stringify({
            success: true,
            message: 'Stream ended'
          }), { 
            status: 200, 
            headers: { 'Content-Type': 'application/json' } 
          });
        }
      }
      
      if (!slotId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'No active stream found for this DJ'
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
      
      const slot = slotDoc.data();
      
      if (slot.djId !== djId && !isAdmin) {
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
      
      // Clear active stream
      await db.collection('livestreams').doc('active').set({
        isLive: false,
        currentSlotId: null,
        endedAt: nowISO
      });
      
      // Also update any livestream documents for this DJ
      const djStreams = await db.collection('livestreams')
        .where('djId', '==', djId)
        .where('isLive', '==', true)
        .get();
      
      for (const streamDoc of djStreams.docs) {
        await streamDoc.ref.update({
          isLive: false,
          endedAt: nowISO
        });
      }
      
      // Invalidate server cache so all users see stream ended
      invalidateScheduleCache();
      
      // Check for next DJ in lobby and auto-transition
      const nextInLobby = await db.collection('livestreamSlots')
        .where('status', '==', 'in_lobby')
        .where('startTime', '<=', new Date(now.getTime() + 5 * 60 * 1000).toISOString())
        .orderBy('startTime', 'asc')
        .limit(1)
        .get();
      
      let nextDj = null;
      if (!nextInLobby.empty) {
        const nextSlot = nextInLobby.docs[0];
        nextDj = { id: nextSlot.id, ...nextSlot.data() };
      }
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Stream ended',
        nextInQueue: nextDj
      }), { 
        status: 200, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    // LISTENER HEARTBEAT - register/update listener presence
    if (action === 'heartbeat') {
      const { odamiMa, name, avatar } = data;
      
      if (odamiMa && name) {
        activeListeners.set(odamiMa, {
          id: odamiMa,
          name: name.split(' ')[0] || name, // First name only
          avatar: avatar || null,
          lastSeen: Date.now()
        });
      }
      
      // Clean up and return current listeners
      const listeners = getActiveListeners();
      
      return new Response(JSON.stringify({
        success: true,
        listeners,
        count: listeners.length
      }), { 
        status: 200, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    // LISTENER LEAVE - remove from active listeners
    if (action === 'leave') {
      const { odamiMa } = data;
      if (odamiMa) {
        activeListeners.delete(odamiMa);
      }
      
      return new Response(JSON.stringify({
        success: true
      }), { 
        status: 200, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    // ==========================================
    // TAKEOVER SYSTEM
    // ==========================================
    
    // REQUEST TAKEOVER - Another DJ wants to take over the current stream
    if (action === 'requestTakeover') {
      const { slotId, requesterId, requesterName, requesterAvatar } = data;
      
      if (!slotId || !requesterId || !requesterName) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Slot ID, requester ID and name are required'
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
      
      const slot = slotDoc.data();
      
      // Can't request takeover of your own slot
      if (slot.djId === requesterId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Cannot request takeover of your own slot'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Slot must be live or in_lobby
      if (!['live', 'in_lobby'].includes(slot.status)) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Can only request takeover of active streams'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Check if there's already a pending takeover request
      if (slot.takeoverRequest && slot.takeoverRequest.status === 'pending') {
        return new Response(JSON.stringify({
          success: false,
          error: 'There is already a pending takeover request'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Create takeover request
      await slotRef.update({
        takeoverRequest: {
          requesterId,
          requesterName: requesterName.trim(),
          requesterAvatar: requesterAvatar || null,
          requestedAt: nowISO,
          status: 'pending'
        },
        updatedAt: nowISO
      });
      
      invalidateScheduleCache();
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Takeover request sent to current DJ'
      }), { 
        status: 200, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    // APPROVE TAKEOVER - Current DJ approves the takeover request
    if (action === 'approveTakeover') {
      const { slotId, djId } = data;
      
      if (!slotId || !djId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Slot ID and DJ ID are required'
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
      
      const slot = slotDoc.data();
      
      // Only current DJ can approve
      if (slot.djId !== djId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Only the current DJ can approve takeover'
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Must have a pending takeover request
      if (!slot.takeoverRequest || slot.takeoverRequest.status !== 'pending') {
        return new Response(JSON.stringify({
          success: false,
          error: 'No pending takeover request'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      const takeoverRequest = slot.takeoverRequest;
      
      // Store the original DJ info for history
      const takeoverRecord = {
        originalDjId: slot.djId,
        originalDjName: slot.djName,
        newDjId: takeoverRequest.requesterId,
        newDjName: takeoverRequest.requesterName,
        takenOverAt: nowISO
      };
      
      // Transfer the slot to the new DJ
      // IMPORTANT: The stream key stays the same so there's a seamless transition
      await slotRef.update({
        // Transfer to new DJ
        djId: takeoverRequest.requesterId,
        djName: takeoverRequest.requesterName,
        djAvatar: takeoverRequest.requesterAvatar,
        
        // Clear the takeover request
        takeoverRequest: {
          ...takeoverRequest,
          status: 'approved',
          approvedAt: nowISO
        },
        
        // Add to takeover history
        takeoverHistory: FieldValue.arrayUnion(takeoverRecord),
        
        updatedAt: nowISO
      });
      
      invalidateScheduleCache();
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Takeover approved! Stream key has been transferred.',
        streamKey: slot.streamKey, // Return the stream key for the new DJ
        newDjId: takeoverRequest.requesterId,
        newDjName: takeoverRequest.requesterName
      }), { 
        status: 200, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    // DENY TAKEOVER - Current DJ denies the takeover request
    if (action === 'denyTakeover') {
      const { slotId, djId } = data;
      
      if (!slotId || !djId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Slot ID and DJ ID are required'
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
      
      const slot = slotDoc.data();
      
      // Only current DJ can deny
      if (slot.djId !== djId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Only the current DJ can deny takeover'
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Must have a pending takeover request
      if (!slot.takeoverRequest || slot.takeoverRequest.status !== 'pending') {
        return new Response(JSON.stringify({
          success: false,
          error: 'No pending takeover request'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Clear the takeover request
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
        message: 'Takeover request denied'
      }), { 
        status: 200, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    // CANCEL TAKEOVER REQUEST - Requesting DJ cancels their request
    if (action === 'cancelTakeoverRequest') {
      const { slotId, requesterId } = data;
      
      if (!slotId || !requesterId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Slot ID and requester ID are required'
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
      
      const slot = slotDoc.data();
      
      // Only the requester can cancel their own request
      if (!slot.takeoverRequest || slot.takeoverRequest.requesterId !== requesterId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Not authorized to cancel this request'
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Clear the takeover request
      await slotRef.update({
        takeoverRequest: null,
        updatedAt: nowISO
      });
      
      invalidateScheduleCache();
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Takeover request cancelled'
      }), { 
        status: 200, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    // GET STREAM KEY - Get the stream key for a slot (only for the DJ who owns it)
    if (action === 'getStreamKey') {
      const { slotId, djId } = data;
      
      if (!slotId || !djId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Slot ID and DJ ID are required'
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
      
      const slot = slotDoc.data();
      
      // Only the current DJ can get the stream key
      if (slot.djId !== djId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Not authorized to access this stream key'
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      
      // Determine software type based on slot
      const software = slot.streamType === 'audio' ? 'butt' : 'obs';
      
      // Build URLs using Red5 config
      const rtmpUrl = slot.rtmpUrl || buildRtmpUrl(slot.streamKey);
      const hlsUrl = slot.hlsUrl || buildHlsUrl(slot.streamKey);
      
      return new Response(JSON.stringify({
        success: true,
        streamKey: slot.streamKey,
        software,
        // Red5 RTMP settings
        serverUrl: RED5_CONFIG.server.rtmpUrl,
        rtmpUrl,
        hlsUrl,
        // Legacy Icecast settings (if needed)
        icecastAddress: 'stream.freshwax.co.uk',
        icecastPort: 8000,
        mount: `/${djId.substring(0, 8)}`,
        // Slot info
        slotInfo: {
          id: slotId,
          title: slot.title,
          djName: slot.djName,
          startTime: slot.startTime,
          endTime: slot.endTime,
          status: slot.status,
          genre: slot.genre,
        }
      }), { 
        status: 200, 
        headers: { 'Content-Type': 'application/json' } 
      });
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
