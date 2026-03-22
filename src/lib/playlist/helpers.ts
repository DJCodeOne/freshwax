// src/lib/playlist/helpers.ts
// Extracted helper functions for the global playlist API

import { fetchWithTimeout, createLogger } from '../api-utils';
import { simpleMd5 } from '../pusher';

const log = createLogger('playlist/global');

// KV key for playlist history
const KV_HISTORY_KEY = 'playlist-history';

// Local playlist server URL (H: drive MP3s via Cloudflare tunnel)
const LOCAL_PLAYLIST_SERVER = 'https://playlist.freshwax.co.uk';
// Fallback thumbnail for audio files without thumbnails
const AUDIO_THUMBNAIL_FALLBACK = '/place-holder.webp';

interface PlaylistItem {
  id: string;
  url: string;
  platform: string;
  embedId?: string;
  title?: string;
  thumbnail?: string;
  duration?: number;
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
  reactionCount?: number;
}

// Cache for KV binding (set during request handling for helper functions)
let kvCache: KVNamespace | null = null;

export function setKVCache(kv: KVNamespace) {
  kvCache = kv;
}

// Fetch recently played from history (top 10 items) - USES KV
export async function getRecentlyPlayed(): Promise<Record<string, unknown>[]> {
  try {
    if (!kvCache) return [];
    const data = await kvCache.get(KV_HISTORY_KEY, 'json') as { items?: Record<string, unknown>[] } | null;
    if (data && data.items) {
      return data.items.slice(0, 10);
    }
  } catch (error: unknown) {
    log.warn('[GlobalPlaylist] Could not fetch recently played:', error);
  }
  return [];
}

// Add a track to the recently played list (keeps only last 10) - USES KV
export async function addToRecentlyPlayed(track: Record<string, unknown>): Promise<void> {
  try {
    if (!kvCache) {
      // KV not available for history
      return;
    }

    // Always save tracks - UI will fetch real titles async if needed
    if (!track.url) {
      // Skipping recently played - no URL
      return;
    }

    // Get current history from KV
    const data = await kvCache.get(KV_HISTORY_KEY, 'json') as { items?: Record<string, unknown>[] } | null;
    let items: Record<string, unknown>[] = data?.items || [];

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

    // Save to KV
    await kvCache.put(KV_HISTORY_KEY, JSON.stringify({
      items,
      lastUpdated: new Date().toISOString()
    }), { expirationTtl: 86400 });
    // Added to recently played
  } catch (error: unknown) {
    log.error('[GlobalPlaylist] Error adding to recently played:', error);
  }
}

// Pick a random track from the local playlist server for auto-play
export async function pickRandomFromLocalServer(env?: Record<string, unknown>): Promise<PlaylistItem | null> {
  try {
    const playlistToken = env?.PLAYLIST_ACCESS_TOKEN || import.meta.env.PLAYLIST_ACCESS_TOKEN || '';
    // Trying local playlist server
    const response = await fetchWithTimeout(`${LOCAL_PLAYLIST_SERVER}/random`, {
      headers: { 'Authorization': `Bearer ${playlistToken}` }
    }, 5000);

    if (!response.ok) {
      // Local server returned non-OK
      return null;
    }

    const data = await response.json() as { success?: boolean; track?: { url?: string; thumbnail?: string; name?: string; duration?: number } };
    if (!data.success || !data.track) {
      // Local server has no tracks
      return null;
    }

    const selected = data.track;
    // Random track selected from local server

    const url = `${LOCAL_PLAYLIST_SERVER}${selected.url}`;
    const thumbnail = selected.thumbnail
      ? `${LOCAL_PLAYLIST_SERVER}${selected.thumbnail}`
      : AUDIO_THUMBNAIL_FALLBACK;

    return {
      id: `auto_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`,
      url: url,
      platform: 'direct',
      title: selected.name,
      thumbnail: thumbnail,
      duration: selected.duration || undefined,
      addedBy: 'system',
      addedByName: 'Auto-Play',
      addedAt: new Date().toISOString()
    };
  } catch (error: unknown) {
    log.warn('[GlobalPlaylist] Local server error:', error);
    return null;
  }
}

// Pick a random track from server-side history for auto-play
// This ensures ALL clients get the SAME track (server is source of truth)
export async function pickRandomFromServerHistory(env?: Record<string, unknown>): Promise<PlaylistItem | null> {
  // Try local playlist server first (H: drive MP3s)
  const localTrack = await pickRandomFromLocalServer(env);
  if (localTrack) {
    return localTrack;
  }

  // Fallback: pick a random track from KV history
  try {
    if (kvCache) {
      const data = await kvCache.get(KV_HISTORY_KEY, 'json') as { items?: Record<string, unknown>[] } | null;
      const items = data?.items;
      if (items && items.length > 0) {
        const pick = items[Math.floor(Math.random() * items.length)];
        if (pick.url) {
          // Autoplay fallback from KV history
          return {
            id: `auto_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`,
            url: pick.url as string,
            platform: (pick.platform as string) || 'direct',
            embedId: pick.embedId as string | undefined,
            title: pick.title as string | undefined,
            thumbnail: pick.thumbnail as string | undefined,
            addedBy: 'system',
            addedByName: 'Auto-Play',
            addedAt: new Date().toISOString()
          };
        }
      }
    }
  } catch (error: unknown) {
    log.warn('[GlobalPlaylist] KV history fallback error:', error);
  }

  // No tracks available for autoplay
  return null;
}

// Broadcast emoji reaction to all viewers via Pusher
export async function broadcastEmojiReaction(emoji: string, sessionId: string, env?: Record<string, unknown>) {
  try {
    const PUSHER_APP_ID = env?.PUSHER_APP_ID || import.meta.env.PUSHER_APP_ID;
    const PUSHER_KEY = env?.PUSHER_KEY || env?.PUBLIC_PUSHER_KEY || import.meta.env.PUSHER_KEY;
    const PUSHER_SECRET = env?.PUSHER_SECRET || import.meta.env.PUSHER_SECRET;
    const PUSHER_CLUSTER = env?.PUSHER_CLUSTER || env?.PUBLIC_PUSHER_CLUSTER || import.meta.env.PUSHER_CLUSTER || 'eu';

    if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET) {
      log.warn('[GlobalPlaylist] Pusher not configured, skipping emoji broadcast');
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
    const bodyMd5 = simpleMd5(body);

    const stringToSign = `POST\n/apps/${PUSHER_APP_ID}/events\nauth_key=${PUSHER_KEY}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}`;
    const signature = await hmacSha256(PUSHER_SECRET as string, stringToSign);

    const url = `https://api-${PUSHER_CLUSTER}.pusher.com/apps/${PUSHER_APP_ID}/events?auth_key=${PUSHER_KEY}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}&auth_signature=${signature}`;

    const pusherResponse = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    }, 5000);

    // Emoji broadcast sent
  } catch (error: unknown) {
    log.error('[GlobalPlaylist] Emoji broadcast error:', error);
  }
}

// In-memory cache for recently played (reduces KV reads)
let recentlyPlayedCache: { items: Record<string, unknown>[], timestamp: number } | null = null;
const RECENTLY_PLAYED_CACHE_TTL = 10000; // 10 seconds

export async function getCachedRecentlyPlayed(): Promise<Record<string, unknown>[]> {
  const now = Date.now();
  if (recentlyPlayedCache && (now - recentlyPlayedCache.timestamp) < RECENTLY_PLAYED_CACHE_TTL) {
    return recentlyPlayedCache.items;
  }
  const items = await getRecentlyPlayed();
  recentlyPlayedCache = { items, timestamp: now };
  return items;
}

// Broadcast playlist update via Pusher (includes recently played)
export async function broadcastPlaylistUpdate(playlist: GlobalPlaylist, env?: Record<string, unknown>) {
  try {
    const PUSHER_APP_ID = env?.PUSHER_APP_ID || import.meta.env.PUSHER_APP_ID;
    const PUSHER_KEY = env?.PUSHER_KEY || env?.PUBLIC_PUSHER_KEY || import.meta.env.PUSHER_KEY;
    const PUSHER_SECRET = env?.PUSHER_SECRET || import.meta.env.PUSHER_SECRET;
    const PUSHER_CLUSTER = env?.PUSHER_CLUSTER || env?.PUBLIC_PUSHER_CLUSTER || import.meta.env.PUSHER_CLUSTER || 'eu';

    if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET) {
      log.warn('[GlobalPlaylist] Pusher not configured, skipping broadcast');
      return;
    }

    // Use cached recently played to reduce KV reads
    const recentlyPlayed = await getCachedRecentlyPlayed();

    const channel = 'live-playlist';
    const event = 'playlist-update';
    const data = JSON.stringify({ ...playlist, recentlyPlayed });

    // Create Pusher signature
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ name: event, channel, data });
    const bodyMd5 = simpleMd5(body);

    const stringToSign = `POST\n/apps/${PUSHER_APP_ID}/events\nauth_key=${PUSHER_KEY}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}`;
    const signature = await hmacSha256(PUSHER_SECRET as string, stringToSign);

    const url = `https://api-${PUSHER_CLUSTER}.pusher.com/apps/${PUSHER_APP_ID}/events?auth_key=${PUSHER_KEY}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}&auth_signature=${signature}`;

    const pusherResponse = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    }, 5000);

    const pusherResult = await pusherResponse.text();
    // Playlist broadcast sent
  } catch (error: unknown) {
    log.error('[GlobalPlaylist] Broadcast error:', error);
  }
}

export async function hmacSha256(key: string, message: string): Promise<string> {
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
