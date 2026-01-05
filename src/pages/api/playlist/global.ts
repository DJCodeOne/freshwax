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
  reactionCount?: number; // Global reaction count, resets per track
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

    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache'
    };

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
      }), { headers });
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
    }), { headers });
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
        trackStartedAt: doc.trackStartedAt || null,
        reactionCount: doc.reactionCount || 0
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
      trackStartedAt: playlist.trackStartedAt || null,
      reactionCount: playlist.reactionCount || 0
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
        trackStartedAt: doc.trackStartedAt || null,
        reactionCount: doc.reactionCount || 0
      };

      const now = new Date().toISOString();

      switch (action) {
        case 'next':
          // Skip current track - remove it and play next user track or autoplay
          if (playlist.queue.length > 0) {
            playlist.queue.shift(); // Remove current track
          }

          if (playlist.queue.length > 0) {
            // Play next user-added track
            playlist.isPlaying = true;
            playlist.trackStartedAt = now;
            playlist.currentIndex = 0;
            console.log('[GlobalPlaylist] Next: playing user track', playlist.queue[0]?.title);
          } else {
            // Queue empty - pick random track for autoplay
            const nextRandomTrack = await pickRandomFromServerHistory();
            if (nextRandomTrack) {
              playlist.queue.push(nextRandomTrack);
              playlist.isPlaying = true;
              playlist.trackStartedAt = now;
              playlist.currentIndex = 0;
              console.log('[GlobalPlaylist] Next: autoplay picked', nextRandomTrack.title || nextRandomTrack.url);
            } else {
              playlist.isPlaying = false;
              playlist.trackStartedAt = null;
            }
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
          const { trackId, finishedTrackTitle } = body;
          const currentTrack = playlist.queue[0];

          // RACE PROTECTION 1: If trackId provided and doesn't match current track, already handled
          if (trackId && currentTrack && currentTrack.id !== trackId) {
            console.log('[GlobalPlaylist] trackEnded ignored - track already changed');
            return new Response(JSON.stringify({
              success: true,
              alreadyHandled: true,
              playlist
            }), {
              headers: { 'Content-Type': 'application/json' }
            });
          }

          // RACE PROTECTION 2: If a new track was started within last 5 seconds, don't pick another
          // This catches cases where multiple clients read old state before any wrote
          const trackJustStarted = playlist.trackStartedAt &&
            (Date.now() - new Date(playlist.trackStartedAt).getTime()) < 5000;
          if (trackJustStarted && playlist.queue.length > 0) {
            console.log('[GlobalPlaylist] trackEnded ignored - new track just started (race protection)');
            return new Response(JSON.stringify({
              success: true,
              alreadyHandled: true,
              playlist
            }), {
              headers: { 'Content-Type': 'application/json' }
            });
          }

          // Save the finished track to recently played before removing
          if (currentTrack) {
            // Use the title from the client if provided (it has the resolved title)
            // Otherwise fall back to the track's title
            const trackTitle = finishedTrackTitle || currentTrack.title;
            await addToRecentlyPlayed({
              ...currentTrack,
              title: trackTitle,
              playedAt: now
            });
          }

          // Remove only the finished track (first in queue)
          // User-added tracks should play next - autoplay only when queue is empty
          if (playlist.queue.length > 0) {
            playlist.queue.shift(); // Remove first item (the one that just ended)
          }

          // If queue still has items (user-added tracks), play them
          if (playlist.queue.length > 0) {
            playlist.isPlaying = true;
            playlist.trackStartedAt = now;
            console.log('[GlobalPlaylist] Playing next user track:', playlist.queue[0]?.title || playlist.queue[0]?.url);
          } else {
            // Queue is empty - pick a random track for autoplay
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
          }
          playlist.currentIndex = 0; // Always play from front of queue
          playlist.reactionCount = 0; // Reset reactions for new track
          break;

        case 'react':
          // Increment global reaction count
          playlist.reactionCount = (playlist.reactionCount || 0) + 1;
          // Broadcast emoji animation to all viewers
          const { emoji, sessionId } = body;
          if (emoji) {
            await broadcastEmojiReaction(emoji, sessionId, (locals as any)?.runtime?.env);
          }
          break;

        case 'startAutoPlay':
          // Server picks autoplay track - ensures ALL clients play the SAME track
          // This is called when queue is empty and clients want to start autoplay

          // RACE PROTECTION: If a track was started within last 10 seconds, don't pick new one
          // This prevents multiple clients from racing to pick different tracks
          const recentlyStarted = playlist.trackStartedAt &&
            (Date.now() - new Date(playlist.trackStartedAt).getTime()) < 10000;

          if (playlist.queue.length === 0 && !recentlyStarted) {
            const autoTrack = await pickRandomFromServerHistory();
            if (autoTrack) {
              playlist.queue.push(autoTrack);
              playlist.isPlaying = true;
              playlist.trackStartedAt = now;
              playlist.currentIndex = 0;
              playlist.reactionCount = 0;
              console.log('[GlobalPlaylist] startAutoPlay: picked', autoTrack.title || autoTrack.url);
            } else {
              console.log('[GlobalPlaylist] startAutoPlay: no tracks available');
            }
          } else if (playlist.queue.length > 0) {
            // Queue already has items - just ensure it's playing
            playlist.isPlaying = true;
            if (!playlist.trackStartedAt) {
              playlist.trackStartedAt = now;
            }
            console.log('[GlobalPlaylist] startAutoPlay: queue has items, resuming');
          } else {
            // Recently started - just return current state, don't change anything
            console.log('[GlobalPlaylist] startAutoPlay: race protection - track just started, returning current state');
          }
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
      trackStartedAt: playlist.trackStartedAt || null,
      reactionCount: playlist.reactionCount || 0
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

// Add a track to the recently played list (keeps only last 10)
async function addToRecentlyPlayed(track: any): Promise<void> {
  try {
    // Always save tracks - UI will fetch real titles async if needed
    if (!track.url) {
      console.log('[GlobalPlaylist] Skipping recently played - no URL');
      return;
    }

    // Get current history
    const historyDoc = await getDocument('liveSettings', 'playlistHistory');
    let items: any[] = historyDoc?.items || [];

    // Create the history item
    const historyItem = {
      id: track.id,
      url: track.url,
      platform: track.platform,
      embedId: track.embedId,
      title: track.title,
      thumbnail: track.thumbnail,
      addedBy: track.addedBy,
      addedByName: track.addedByName,
      playedAt: track.playedAt || new Date().toISOString()
    };

    // Prepend to list and keep only last 10
    items = [historyItem, ...items.filter(item => item.id !== track.id)].slice(0, 10);

    // Save to Firestore (include lastUpdated for Firestore rules)
    await setDocument('liveSettings', 'playlistHistory', {
      items,
      lastUpdated: new Date().toISOString()
    });
    console.log('[GlobalPlaylist] Added to recently played:', track.title);
  } catch (error) {
    console.error('[GlobalPlaylist] Error adding to recently played:', error);
  }
}

// Pick a random track from server-side history for auto-play
// This ensures ALL clients get the SAME track (server is source of truth)
// Local playlist server URL (H: drive MP3s via Cloudflare tunnel)
const LOCAL_PLAYLIST_SERVER = 'https://playlist.freshwax.co.uk';

// Fallback thumbnail for audio files without thumbnails
const AUDIO_THUMBNAIL_FALLBACK = '/place-holder.webp';

async function pickRandomFromLocalServer(): Promise<PlaylistItem | null> {
  try {
    console.log('[GlobalPlaylist] Trying local playlist server...');
    const response = await fetch(`${LOCAL_PLAYLIST_SERVER}/list`, {
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      console.log('[GlobalPlaylist] Local server returned', response.status);
      return null;
    }

    const data = await response.json();
    if (!data.files || data.files.length === 0) {
      console.log('[GlobalPlaylist] Local server has no files');
      return null;
    }

    console.log('[GlobalPlaylist] Local server has', data.files.length, 'MP3 files');

    // Pick a random track (prefer ones with thumbnails)
    const filesWithThumbs = data.files.filter((f: any) => f.thumbnail);
    const filesToPickFrom = filesWithThumbs.length > 0 ? filesWithThumbs : data.files;
    const randomIndex = Math.floor(Math.random() * filesToPickFrom.length);
    const selected = filesToPickFrom[randomIndex];
    const url = `${LOCAL_PLAYLIST_SERVER}${selected.url}`;

    // Use track's own thumbnail if available, otherwise fallback
    const thumbnail = selected.thumbnail
      ? `${LOCAL_PLAYLIST_SERVER}${selected.thumbnail}`
      : AUDIO_THUMBNAIL_FALLBACK;

    console.log('[GlobalPlaylist] Selected local MP3:', selected.name, 'thumb:', !!selected.thumbnail);

    return {
      id: `auto_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`,
      url: url,
      platform: 'direct',
      title: selected.name,
      thumbnail: thumbnail,
      duration: selected.duration || undefined,
      addedBy: 'system',
      addedByName: 'Auto-Play only',
      addedAt: new Date().toISOString()
    };
  } catch (error) {
    console.log('[GlobalPlaylist] Local server error:', error);
    return null;
  }
}

async function pickRandomFromServerHistory(): Promise<PlaylistItem | null> {
  // ONLY use local playlist server (H: drive MP3s) - no YouTube fallback
  const localTrack = await pickRandomFromLocalServer();
  if (localTrack) {
    return localTrack;
  }

  console.log('[GlobalPlaylist] Local playlist server unavailable - no autoplay');
  return null;
}

// Broadcast emoji reaction to all viewers via Pusher
async function broadcastEmojiReaction(emoji: string, sessionId: string, env?: any) {
  try {
    const PUSHER_APP_ID = env?.PUSHER_APP_ID || import.meta.env.PUSHER_APP_ID;
    const PUSHER_KEY = env?.PUSHER_KEY || env?.PUBLIC_PUSHER_KEY || import.meta.env.PUSHER_KEY;
    const PUSHER_SECRET = env?.PUSHER_SECRET || import.meta.env.PUSHER_SECRET;
    const PUSHER_CLUSTER = env?.PUSHER_CLUSTER || env?.PUBLIC_PUSHER_CLUSTER || import.meta.env.PUSHER_CLUSTER || 'eu';

    if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET) {
      console.warn('[GlobalPlaylist] Pusher not configured, skipping emoji broadcast');
      return;
    }

    // Broadcast to the stream channel (same channel livestream uses)
    const channel = 'stream-playlist-global';
    const event = 'reaction';
    const data = JSON.stringify({
      type: 'emoji',
      emoji: emoji,
      sessionId: sessionId || '',
      timestamp: Date.now()
    });

    // Create Pusher signature
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ name: event, channel, data });
    const bodyMd5 = md5(body);

    const stringToSign = `POST\n/apps/${PUSHER_APP_ID}/events\nauth_key=${PUSHER_KEY}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}`;
    const signature = await hmacSha256(PUSHER_SECRET, stringToSign);

    const url = `https://api-${PUSHER_CLUSTER}.pusher.com/apps/${PUSHER_APP_ID}/events?auth_key=${PUSHER_KEY}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}&auth_signature=${signature}`;

    const pusherResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });

    console.log('[GlobalPlaylist] Emoji broadcast response:', pusherResponse.status);
  } catch (error) {
    console.error('[GlobalPlaylist] Emoji broadcast error:', error);
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
    const bodyMd5 = md5(body);

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
// Pure JS MD5 implementation for Cloudflare Workers
function md5(message: string): string {
  function rotateLeft(x: number, n: number) {
    return (x << n) | (x >>> (32 - n));
  }

  function addUnsigned(x: number, y: number) {
    const x4 = x & 0x80000000;
    const y4 = y & 0x80000000;
    const x8 = x & 0x40000000;
    const y8 = y & 0x40000000;
    const result = (x & 0x3FFFFFFF) + (y & 0x3FFFFFFF);
    if (x8 & y8) return result ^ 0x80000000 ^ x4 ^ y4;
    if (x8 | y8) {
      if (result & 0x40000000) return result ^ 0xC0000000 ^ x4 ^ y4;
      return result ^ 0x40000000 ^ x4 ^ y4;
    }
    return result ^ x4 ^ y4;
  }

  function F(x: number, y: number, z: number) { return (x & y) | (~x & z); }
  function G(x: number, y: number, z: number) { return (x & z) | (y & ~z); }
  function H(x: number, y: number, z: number) { return x ^ y ^ z; }
  function I(x: number, y: number, z: number) { return y ^ (x | ~z); }

  function FF(a: number, b: number, c: number, d: number, x: number, s: number, ac: number) {
    a = addUnsigned(a, addUnsigned(addUnsigned(F(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }
  function GG(a: number, b: number, c: number, d: number, x: number, s: number, ac: number) {
    a = addUnsigned(a, addUnsigned(addUnsigned(G(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }
  function HH(a: number, b: number, c: number, d: number, x: number, s: number, ac: number) {
    a = addUnsigned(a, addUnsigned(addUnsigned(H(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }
  function II(a: number, b: number, c: number, d: number, x: number, s: number, ac: number) {
    a = addUnsigned(a, addUnsigned(addUnsigned(I(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }

  function convertToWordArray(str: string) {
    const wordCount = ((str.length + 8 - (str.length + 8) % 64) / 64 + 1) * 16;
    const wordArray = Array(wordCount - 1).fill(0);
    let bytePos = 0, byteCount = 0;
    while (byteCount < str.length) {
      const wordPos = (byteCount - byteCount % 4) / 4;
      bytePos = (byteCount % 4) * 8;
      wordArray[wordPos] = wordArray[wordPos] | (str.charCodeAt(byteCount) << bytePos);
      byteCount++;
    }
    const wordPos = (byteCount - byteCount % 4) / 4;
    bytePos = (byteCount % 4) * 8;
    wordArray[wordPos] = wordArray[wordPos] | (0x80 << bytePos);
    wordArray[wordCount - 2] = str.length << 3;
    wordArray[wordCount - 1] = str.length >>> 29;
    return wordArray;
  }

  function wordToHex(value: number) {
    let hex = '', temp = '';
    for (let i = 0; i <= 3; i++) {
      temp = ((value >>> (i * 8)) & 255).toString(16);
      hex += (temp.length < 2 ? '0' + temp : temp);
    }
    return hex;
  }

  const x = convertToWordArray(message);
  let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;
  const S11 = 7, S12 = 12, S13 = 17, S14 = 22;
  const S21 = 5, S22 = 9, S23 = 14, S24 = 20;
  const S31 = 4, S32 = 11, S33 = 16, S34 = 23;
  const S41 = 6, S42 = 10, S43 = 15, S44 = 21;

  for (let k = 0; k < x.length; k += 16) {
    const AA = a, BB = b, CC = c, DD = d;
    a = FF(a, b, c, d, x[k], S11, 0xD76AA478); d = FF(d, a, b, c, x[k+1], S12, 0xE8C7B756);
    c = FF(c, d, a, b, x[k+2], S13, 0x242070DB); b = FF(b, c, d, a, x[k+3], S14, 0xC1BDCEEE);
    a = FF(a, b, c, d, x[k+4], S11, 0xF57C0FAF); d = FF(d, a, b, c, x[k+5], S12, 0x4787C62A);
    c = FF(c, d, a, b, x[k+6], S13, 0xA8304613); b = FF(b, c, d, a, x[k+7], S14, 0xFD469501);
    a = FF(a, b, c, d, x[k+8], S11, 0x698098D8); d = FF(d, a, b, c, x[k+9], S12, 0x8B44F7AF);
    c = FF(c, d, a, b, x[k+10], S13, 0xFFFF5BB1); b = FF(b, c, d, a, x[k+11], S14, 0x895CD7BE);
    a = FF(a, b, c, d, x[k+12], S11, 0x6B901122); d = FF(d, a, b, c, x[k+13], S12, 0xFD987193);
    c = FF(c, d, a, b, x[k+14], S13, 0xA679438E); b = FF(b, c, d, a, x[k+15], S14, 0x49B40821);

    a = GG(a, b, c, d, x[k+1], S21, 0xF61E2562); d = GG(d, a, b, c, x[k+6], S22, 0xC040B340);
    c = GG(c, d, a, b, x[k+11], S23, 0x265E5A51); b = GG(b, c, d, a, x[k], S24, 0xE9B6C7AA);
    a = GG(a, b, c, d, x[k+5], S21, 0xD62F105D); d = GG(d, a, b, c, x[k+10], S22, 0x2441453);
    c = GG(c, d, a, b, x[k+15], S23, 0xD8A1E681); b = GG(b, c, d, a, x[k+4], S24, 0xE7D3FBC8);
    a = GG(a, b, c, d, x[k+9], S21, 0x21E1CDE6); d = GG(d, a, b, c, x[k+14], S22, 0xC33707D6);
    c = GG(c, d, a, b, x[k+3], S23, 0xF4D50D87); b = GG(b, c, d, a, x[k+8], S24, 0x455A14ED);
    a = GG(a, b, c, d, x[k+13], S21, 0xA9E3E905); d = GG(d, a, b, c, x[k+2], S22, 0xFCEFA3F8);
    c = GG(c, d, a, b, x[k+7], S23, 0x676F02D9); b = GG(b, c, d, a, x[k+12], S24, 0x8D2A4C8A);

    a = HH(a, b, c, d, x[k+5], S31, 0xFFFA3942); d = HH(d, a, b, c, x[k+8], S32, 0x8771F681);
    c = HH(c, d, a, b, x[k+11], S33, 0x6D9D6122); b = HH(b, c, d, a, x[k+14], S34, 0xFDE5380C);
    a = HH(a, b, c, d, x[k+1], S31, 0xA4BEEA44); d = HH(d, a, b, c, x[k+4], S32, 0x4BDECFA9);
    c = HH(c, d, a, b, x[k+7], S33, 0xF6BB4B60); b = HH(b, c, d, a, x[k+10], S34, 0xBEBFBC70);
    a = HH(a, b, c, d, x[k+13], S31, 0x289B7EC6); d = HH(d, a, b, c, x[k], S32, 0xEAA127FA);
    c = HH(c, d, a, b, x[k+3], S33, 0xD4EF3085); b = HH(b, c, d, a, x[k+6], S34, 0x4881D05);
    a = HH(a, b, c, d, x[k+9], S31, 0xD9D4D039); d = HH(d, a, b, c, x[k+12], S32, 0xE6DB99E5);
    c = HH(c, d, a, b, x[k+15], S33, 0x1FA27CF8); b = HH(b, c, d, a, x[k+2], S34, 0xC4AC5665);

    a = II(a, b, c, d, x[k], S41, 0xF4292244); d = II(d, a, b, c, x[k+7], S42, 0x432AFF97);
    c = II(c, d, a, b, x[k+14], S43, 0xAB9423A7); b = II(b, c, d, a, x[k+5], S44, 0xFC93A039);
    a = II(a, b, c, d, x[k+12], S41, 0x655B59C3); d = II(d, a, b, c, x[k+3], S42, 0x8F0CCC92);
    c = II(c, d, a, b, x[k+10], S43, 0xFFEFF47D); b = II(b, c, d, a, x[k+1], S44, 0x85845DD1);
    a = II(a, b, c, d, x[k+8], S41, 0x6FA87E4F); d = II(d, a, b, c, x[k+15], S42, 0xFE2CE6E0);
    c = II(c, d, a, b, x[k+6], S43, 0xA3014314); b = II(b, c, d, a, x[k+13], S44, 0x4E0811A1);
    a = II(a, b, c, d, x[k+4], S41, 0xF7537E82); d = II(d, a, b, c, x[k+11], S42, 0xBD3AF235);
    c = II(c, d, a, b, x[k+2], S43, 0x2AD7D2BB); b = II(b, c, d, a, x[k+9], S44, 0xEB86D391);

    a = addUnsigned(a, AA); b = addUnsigned(b, BB); c = addUnsigned(c, CC); d = addUnsigned(d, DD);
  }
  return wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d);
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
