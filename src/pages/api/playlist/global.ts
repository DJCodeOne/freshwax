// src/pages/api/playlist/global.ts
// Global playlist API - shared across all viewers

import type { APIContext } from 'astro';
import { getDocument, setDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

const GLOBAL_PLAYLIST_DOC = 'globalPlaylist';

// Helper to init Firebase env from Cloudflare runtime
// Note: PUBLIC_FIREBASE_API_KEY is safe to include - it's a client-side key
const FALLBACK_API_KEY = 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g';

function initEnv(locals: any) {
  const env = (locals as any).runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || env?.PUBLIC_FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || env?.PUBLIC_FIREBASE_API_KEY || FALLBACK_API_KEY,
  });
}
const MAX_QUEUE_SIZE = 10;

interface PlaylistItem {
  id: string;
  url: string;
  platform: string;
  embedId?: string;
  title?: string;
  thumbnail?: string;
  addedBy?: string;
  addedByName?: string;
  addedAt: string;
}

interface GlobalPlaylist {
  queue: PlaylistItem[];
  currentIndex: number;
  isPlaying: boolean;
  lastUpdated: string;
  trackStartedAt?: string | null;
}

// Convert Firestore document fields to JSON
function firestoreToJson(doc: any): any {
  if (!doc?.fields) return doc;

  const result: any = {};
  for (const [key, value] of Object.entries(doc.fields)) {
    result[key] = parseFirestoreValue(value);
  }
  return result;
}

function parseFirestoreValue(value: any): any {
  if (value === null || value === undefined) return null;

  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return parseInt(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) {
    return (value.arrayValue.values || []).map(parseFirestoreValue);
  }
  if ('mapValue' in value) {
    const result: any = {};
    for (const [k, v] of Object.entries(value.mapValue.fields || {})) {
      result[k] = parseFirestoreValue(v);
    }
    return result;
  }
  return value;
}

// Convert JSON to Firestore format
function jsonToFirestore(obj: any): any {
  if (obj === null || obj === undefined) {
    return { nullValue: null };
  }
  if (typeof obj === 'string') {
    return { stringValue: obj };
  }
  if (typeof obj === 'number') {
    return Number.isInteger(obj)
      ? { integerValue: obj.toString() }
      : { doubleValue: obj };
  }
  if (typeof obj === 'boolean') {
    return { booleanValue: obj };
  }
  if (Array.isArray(obj)) {
    return { arrayValue: { values: obj.map(jsonToFirestore) } };
  }
  if (typeof obj === 'object') {
    const fields: any = {};
    for (const [key, value] of Object.entries(obj)) {
      fields[key] = jsonToFirestore(value);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(obj) };
}

// GET - Fetch global playlist
export async function GET({ request, locals }: APIContext) {
  try {
    initEnv(locals);
    const doc = await getDocument('liveSettings', GLOBAL_PLAYLIST_DOC);

    if (!doc) {
      // Return empty playlist
      return new Response(JSON.stringify({
        success: true,
        playlist: {
          queue: [],
          currentIndex: 0,
          isPlaying: false,
          lastUpdated: new Date().toISOString(),
          trackStartedAt: null
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      playlist: {
        queue: doc.queue || [],
        currentIndex: doc.currentIndex || 0,
        isPlaying: doc.isPlaying || false,
        lastUpdated: doc.lastUpdated || new Date().toISOString(),
        trackStartedAt: doc.trackStartedAt || null
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('[GlobalPlaylist] GET error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// POST - Add item to playlist (requires auth)
export async function POST({ request, locals }: APIContext) {
  try {
    initEnv(locals);
    const body = await request.json();
    const { item, userId, userName } = body;

    if (!item || !userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing item or userId'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get current playlist
    let playlist: GlobalPlaylist = {
      queue: [],
      currentIndex: 0,
      isPlaying: false,
      lastUpdated: new Date().toISOString(),
      trackStartedAt: null
    };

    const doc = await getDocument('liveSettings', GLOBAL_PLAYLIST_DOC);
    if (doc) {
      playlist = {
        queue: doc.queue || [],
        currentIndex: doc.currentIndex || 0,
        isPlaying: doc.isPlaying || false,
        lastUpdated: doc.lastUpdated || new Date().toISOString(),
        trackStartedAt: doc.trackStartedAt || null
      };
    }

    // Check queue size
    if (playlist.queue.length >= MAX_QUEUE_SIZE) {
      return new Response(JSON.stringify({
        success: false,
        error: `Queue is full (${MAX_QUEUE_SIZE} items max)`
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // DJ Waitlist: Check if user already has max tracks in queue (2 tracks per DJ)
    const userTracksInQueue = playlist.queue.filter(item => item.addedBy === userId).length;
    if (userTracksInQueue >= 2) {
      return new Response(JSON.stringify({
        success: false,
        error: 'You already have 2 tracks in the queue. Wait for one to play or remove it first.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Add item with user info
    const newItem: PlaylistItem = {
      ...item,
      addedBy: userId,
      addedByName: userName || 'Anonymous',
      addedAt: new Date().toISOString()
    };

    playlist.queue.push(newItem);
    playlist.lastUpdated = new Date().toISOString();

    // If first item, start playing and set track start time
    if (playlist.queue.length === 1 && !playlist.isPlaying) {
      playlist.isPlaying = true;
      playlist.trackStartedAt = new Date().toISOString();
    }

    // Save to Firebase using the fields format
    await setDocument('liveSettings', GLOBAL_PLAYLIST_DOC, {
      queue: playlist.queue,
      currentIndex: playlist.currentIndex,
      isPlaying: playlist.isPlaying,
      lastUpdated: playlist.lastUpdated,
      trackStartedAt: playlist.trackStartedAt || null
    });

    // Trigger Pusher broadcast
    await broadcastPlaylistUpdate(playlist, (locals as any)?.runtime?.env);

    return new Response(JSON.stringify({
      success: true,
      playlist,
      message: playlist.queue.length === 1 ? 'Now playing' : 'Added to queue'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('[GlobalPlaylist] POST error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// DELETE - Remove item from playlist
export async function DELETE({ request, locals }: APIContext) {
  try {
    initEnv(locals);
    const body = await request.json();
    const { itemId, userId } = body;

    if (!itemId || !userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing itemId or userId'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const doc = await getDocument('liveSettings', GLOBAL_PLAYLIST_DOC);

    if (!doc) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Playlist not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    let playlist: GlobalPlaylist = {
      queue: doc.queue || [],
      currentIndex: doc.currentIndex || 0,
      isPlaying: doc.isPlaying || false,
      lastUpdated: doc.lastUpdated || new Date().toISOString(),
      trackStartedAt: doc.trackStartedAt || null
    };

    // Find and remove item (only if user owns it or is admin)
    const itemIndex = playlist.queue.findIndex(item => item.id === itemId);
    if (itemIndex === -1) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Item not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const item = playlist.queue[itemIndex];
    // Allow removal if user owns the item (admin check would go here too)
    if (item.addedBy !== userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'You can only remove your own items'
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const wasCurrentlyPlaying = itemIndex === playlist.currentIndex;
    playlist.queue.splice(itemIndex, 1);

    // Adjust currentIndex
    if (itemIndex < playlist.currentIndex) {
      playlist.currentIndex = Math.max(0, playlist.currentIndex - 1);
    } else if (itemIndex === playlist.currentIndex && playlist.queue.length > 0) {
      playlist.currentIndex = Math.min(playlist.currentIndex, playlist.queue.length - 1);
    }

    // Stop if queue is empty
    if (playlist.queue.length === 0) {
      playlist.isPlaying = false;
      playlist.currentIndex = 0;
      playlist.trackStartedAt = null;
    } else if (wasCurrentlyPlaying) {
      // Reset track start time if we removed the current track (new track starts)
      playlist.trackStartedAt = new Date().toISOString();
    }

    playlist.lastUpdated = new Date().toISOString();

    // Save to Firebase
    await setDocument('liveSettings', GLOBAL_PLAYLIST_DOC, {
      queue: playlist.queue,
      currentIndex: playlist.currentIndex,
      isPlaying: playlist.isPlaying,
      lastUpdated: playlist.lastUpdated,
      trackStartedAt: playlist.trackStartedAt || null
    });

    // Trigger Pusher broadcast
    await broadcastPlaylistUpdate(playlist, (locals as any)?.runtime?.env);

    return new Response(JSON.stringify({
      success: true,
      playlist
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('[GlobalPlaylist] DELETE error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// PUT - Update playlist state (next track, play/pause, sync)
export async function PUT({ request, locals }: APIContext) {
  try {
    initEnv(locals);
    const body = await request.json();
    const { action, userId, playlist: syncPlaylist } = body;

    if (!action) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing action'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    let playlist: GlobalPlaylist;

    // For 'sync' action, use the provided playlist directly
    if (action === 'sync' && syncPlaylist) {
      playlist = {
        queue: syncPlaylist.queue || [],
        currentIndex: syncPlaylist.currentIndex || 0,
        isPlaying: syncPlaylist.isPlaying || false,
        lastUpdated: new Date().toISOString(),
        trackStartedAt: syncPlaylist.trackStartedAt || null
      };
    } else {
      // For other actions, load from Firestore first
      const doc = await getDocument('liveSettings', GLOBAL_PLAYLIST_DOC);

      if (!doc) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Playlist not found'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      playlist = {
        queue: doc.queue || [],
        currentIndex: doc.currentIndex || 0,
        isPlaying: doc.isPlaying || false,
        lastUpdated: doc.lastUpdated || new Date().toISOString(),
        trackStartedAt: doc.trackStartedAt || null
      };

      const now = new Date().toISOString();

      switch (action) {
        case 'next':
          if (playlist.queue.length > 0) {
            playlist.currentIndex = (playlist.currentIndex + 1) % playlist.queue.length;
            // Reset track start time for new track
            playlist.trackStartedAt = now;
          }
          break;
        case 'play':
          playlist.isPlaying = true;
          // Set track start time when resuming/starting
          playlist.trackStartedAt = now;
          break;
        case 'pause':
          playlist.isPlaying = false;
          // Clear track start time when paused
          playlist.trackStartedAt = null;
          break;
        case 'toggle':
          playlist.isPlaying = !playlist.isPlaying;
          // Update track start time based on new state
          playlist.trackStartedAt = playlist.isPlaying ? now : null;
          break;
        case 'trackEnded':
          // SERVER picks next track - ensures all clients play the same thing
          // Use trackId to prevent race conditions (multiple clients calling trackEnded)
          const { trackId } = body;
          const currentTrack = playlist.queue[0];

          // If trackId provided and doesn't match current track, already handled by another client
          if (trackId && currentTrack && currentTrack.id !== trackId) {
            console.log('[GlobalPlaylist] trackEnded ignored - track already changed');
            // Return current playlist with alreadyHandled flag - client should NOT start playback
            // (Pusher will handle sync for this client)
            return new Response(JSON.stringify({
              success: true,
              alreadyHandled: true,
              playlist
            }), {
              headers: { 'Content-Type': 'application/json' }
            });
          }

          // Remove the finished track (always index 0 for queue-style playlist)
          if (playlist.queue.length > 0) {
            playlist.queue.shift(); // Remove first item
          }

          // If queue is now empty, pick a random track from history
          if (playlist.queue.length === 0) {
            const randomTrack = await pickRandomFromServerHistory();
            if (randomTrack) {
              playlist.queue.push(randomTrack);
              playlist.isPlaying = true;
              playlist.trackStartedAt = now;
              console.log('[GlobalPlaylist] Auto-play: picked', randomTrack.title || randomTrack.url);
            } else {
              // No tracks available - stop playback
              playlist.isPlaying = false;
              playlist.trackStartedAt = null;
              console.log('[GlobalPlaylist] No tracks for auto-play, stopping');
            }
          } else {
            // Queue has more items, continue with next
            playlist.trackStartedAt = now;
          }
          playlist.currentIndex = 0; // Always play from front of queue
          break;
      }

      playlist.lastUpdated = now;
    }

    // Save to Firebase
    await setDocument('liveSettings', GLOBAL_PLAYLIST_DOC, {
      queue: playlist.queue,
      currentIndex: playlist.currentIndex,
      isPlaying: playlist.isPlaying,
      lastUpdated: playlist.lastUpdated,
      trackStartedAt: playlist.trackStartedAt || null
    });

    // Trigger Pusher broadcast
    await broadcastPlaylistUpdate(playlist, (locals as any)?.runtime?.env);

    return new Response(JSON.stringify({
      success: true,
      playlist
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('[GlobalPlaylist] PUT error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Fetch recently played from history (top 10 items)
async function getRecentlyPlayed(): Promise<any[]> {
  try {
    const historyDoc = await getDocument('liveSettings', 'playlistHistory');
    if (historyDoc && historyDoc.items) {
      return historyDoc.items.slice(0, 10);
    }
  } catch (error) {
    console.warn('[GlobalPlaylist] Could not fetch recently played:', error);
  }
  return [];
}

// Pick a random track from server-side history for auto-play
// This ensures ALL clients get the SAME track (server is source of truth)
async function pickRandomFromServerHistory(): Promise<PlaylistItem | null> {
  try {
    // Try multiple history shards (playlistHistory_1, playlistHistory_2, etc.)
    const allItems: any[] = [];

    // Check main history doc first
    const mainHistory = await getDocument('liveSettings', 'playlistHistory');
    if (mainHistory?.items?.length > 0) {
      allItems.push(...mainHistory.items);
    }

    // Check sharded history docs (for large history)
    for (let i = 1; i <= 10; i++) {
      try {
        const shardDoc = await getDocument('liveSettings', `playlistHistory_${i}`);
        if (shardDoc?.items?.length > 0) {
          allItems.push(...shardDoc.items);
        }
      } catch {
        break; // No more shards
      }
    }

    if (allItems.length === 0) {
      console.log('[GlobalPlaylist] No tracks in history for auto-play');
      return null;
    }

    console.log('[GlobalPlaylist] History has', allItems.length, 'tracks for auto-play');

    // Pick a random track
    const randomIndex = Math.floor(Math.random() * allItems.length);
    const selected = allItems[randomIndex];

    // Convert to PlaylistItem format
    return {
      id: `auto_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`,
      url: selected.url,
      platform: selected.platform || 'youtube',
      embedId: selected.embedId,
      title: selected.title,
      thumbnail: selected.thumbnail,
      addedBy: 'system',
      addedByName: 'Auto-Play',
      addedAt: new Date().toISOString()
    };
  } catch (error) {
    console.error('[GlobalPlaylist] Error picking random track:', error);
    return null;
  }
}

// Broadcast playlist update via Pusher (includes recently played)
async function broadcastPlaylistUpdate(playlist: GlobalPlaylist, env?: any) {
  try {
    const PUSHER_APP_ID = env?.PUSHER_APP_ID || import.meta.env.PUSHER_APP_ID;
    const PUSHER_KEY = env?.PUSHER_KEY || env?.PUBLIC_PUSHER_KEY || import.meta.env.PUSHER_KEY;
    const PUSHER_SECRET = env?.PUSHER_SECRET || import.meta.env.PUSHER_SECRET;
    const PUSHER_CLUSTER = env?.PUSHER_CLUSTER || env?.PUBLIC_PUSHER_CLUSTER || import.meta.env.PUSHER_CLUSTER || 'eu';

    console.log('[GlobalPlaylist] Broadcast attempt - env available:', !!env);
    console.log('[GlobalPlaylist] Pusher config:', {
      hasAppId: !!PUSHER_APP_ID,
      hasKey: !!PUSHER_KEY,
      hasSecret: !!PUSHER_SECRET,
      cluster: PUSHER_CLUSTER
    });

    if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET) {
      console.warn('[GlobalPlaylist] Pusher not configured, skipping broadcast');
      return;
    }

    // Fetch recently played to include in broadcast
    const recentlyPlayed = await getRecentlyPlayed();

    const channel = 'live-playlist';
    const event = 'playlist-update';
    const data = JSON.stringify({ ...playlist, recentlyPlayed });

    // Create Pusher signature
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ name: event, channel, data });
    const bodyMd5 = await md5(body);

    const stringToSign = `POST\n/apps/${PUSHER_APP_ID}/events\nauth_key=${PUSHER_KEY}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}`;
    const signature = await hmacSha256(PUSHER_SECRET, stringToSign);

    const url = `https://api-${PUSHER_CLUSTER}.pusher.com/apps/${PUSHER_APP_ID}/events?auth_key=${PUSHER_KEY}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}&auth_signature=${signature}`;

    const pusherResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });

    const pusherResult = await pusherResponse.text();
    console.log('[GlobalPlaylist] Broadcast response:', pusherResponse.status, pusherResult);
  } catch (error) {
    console.error('[GlobalPlaylist] Broadcast error:', error);
  }
}

// Helper functions for Pusher signature
async function md5(message: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  // Use SHA-256 as MD5 fallback (Cloudflare Workers don't support MD5)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 32);
}

async function hmacSha256(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const messageData = encoder.encode(message);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
