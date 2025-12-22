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
          lastUpdated: new Date().toISOString()
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
        lastUpdated: doc.lastUpdated || new Date().toISOString()
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
      lastUpdated: new Date().toISOString()
    };

    const doc = await getDocument('liveSettings', GLOBAL_PLAYLIST_DOC);
    if (doc) {
      playlist = {
        queue: doc.queue || [],
        currentIndex: doc.currentIndex || 0,
        isPlaying: doc.isPlaying || false,
        lastUpdated: doc.lastUpdated || new Date().toISOString()
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

    // Add item with user info
    const newItem: PlaylistItem = {
      ...item,
      addedBy: userId,
      addedByName: userName || 'Anonymous',
      addedAt: new Date().toISOString()
    };

    playlist.queue.push(newItem);
    playlist.lastUpdated = new Date().toISOString();

    // If first item, start playing
    if (playlist.queue.length === 1 && !playlist.isPlaying) {
      playlist.isPlaying = true;
    }

    // Save to Firebase using the fields format
    await setDocument('liveSettings', GLOBAL_PLAYLIST_DOC, {
      queue: playlist.queue,
      currentIndex: playlist.currentIndex,
      isPlaying: playlist.isPlaying,
      lastUpdated: playlist.lastUpdated
    });

    // Trigger Pusher broadcast
    await broadcastPlaylistUpdate(playlist);

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
      lastUpdated: doc.lastUpdated || new Date().toISOString()
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
    }

    playlist.lastUpdated = new Date().toISOString();

    // Save to Firebase
    await setDocument('liveSettings', GLOBAL_PLAYLIST_DOC, {
      queue: playlist.queue,
      currentIndex: playlist.currentIndex,
      isPlaying: playlist.isPlaying,
      lastUpdated: playlist.lastUpdated
    });

    // Trigger Pusher broadcast
    await broadcastPlaylistUpdate(playlist);

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
        lastUpdated: new Date().toISOString()
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
        lastUpdated: doc.lastUpdated || new Date().toISOString()
      };

      switch (action) {
        case 'next':
          if (playlist.queue.length > 0) {
            playlist.currentIndex = (playlist.currentIndex + 1) % playlist.queue.length;
          }
          break;
        case 'play':
          playlist.isPlaying = true;
          break;
        case 'pause':
          playlist.isPlaying = false;
          break;
        case 'toggle':
          playlist.isPlaying = !playlist.isPlaying;
          break;
      }

      playlist.lastUpdated = new Date().toISOString();
    }

    // Save to Firebase
    await setDocument('liveSettings', GLOBAL_PLAYLIST_DOC, {
      queue: playlist.queue,
      currentIndex: playlist.currentIndex,
      isPlaying: playlist.isPlaying,
      lastUpdated: playlist.lastUpdated
    });

    // Trigger Pusher broadcast
    await broadcastPlaylistUpdate(playlist);

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

// Broadcast playlist update via Pusher
async function broadcastPlaylistUpdate(playlist: GlobalPlaylist) {
  try {
    const PUSHER_APP_ID = import.meta.env.PUSHER_APP_ID;
    const PUSHER_KEY = import.meta.env.PUSHER_KEY;
    const PUSHER_SECRET = import.meta.env.PUSHER_SECRET;
    const PUSHER_CLUSTER = import.meta.env.PUSHER_CLUSTER || 'eu';

    if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET) {
      console.warn('[GlobalPlaylist] Pusher not configured, skipping broadcast');
      return;
    }

    const channel = 'live-playlist';
    const event = 'playlist-update';
    const data = JSON.stringify(playlist);

    // Create Pusher signature
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ name: event, channel, data });
    const bodyMd5 = await md5(body);

    const stringToSign = `POST\n/apps/${PUSHER_APP_ID}/events\nauth_key=${PUSHER_KEY}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}`;
    const signature = await hmacSha256(PUSHER_SECRET, stringToSign);

    const url = `https://api-${PUSHER_CLUSTER}.pusher.com/apps/${PUSHER_APP_ID}/events?auth_key=${PUSHER_KEY}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}&auth_signature=${signature}`;

    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });

    console.log('[GlobalPlaylist] Broadcast sent');
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
