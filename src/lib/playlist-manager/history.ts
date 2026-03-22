// src/lib/playlist-manager/history.ts
// Play history, recently-played cooldown tracking, and auto-play from history

import type { GlobalPlaylistItem } from '../types';
import { createClientLogger } from '../client-logger';
import {
  PLAYLIST_HISTORY_KEY,
  RECENTLY_PLAYED_KEY,
  MAX_HISTORY_SIZE,
  TRACK_COOLDOWN_MS,
  LOCAL_PLAYLIST_SERVER,
  AUDIO_THUMBNAIL_FALLBACK,
} from './types';
import { TIMEOUTS } from '../timeouts';
import type {
  PlaylistHistoryEntry,
  ServerHistoryItem,
  ServerFileItem,
} from './types';
import { isPlaceholderTitle, fetchYouTubeTitle } from './metadata';

const log = createClientLogger('PlaylistHistory');

// ============================================
// RECENTLY PLAYED (cooldown tracking)
// ============================================

/**
 * Load recently played URLs from localStorage
 * Returns a Map of URL -> timestamp
 */
export function loadRecentlyPlayedFromStorage(): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const stored = localStorage.getItem(RECENTLY_PLAYED_KEY);
    if (stored) {
      const data = JSON.parse(stored);
      const now = Date.now();
      // Only keep entries within cooldown period
      for (const [url, timestamp] of Object.entries(data)) {
        if (now - (timestamp as number) < TRACK_COOLDOWN_MS) {
          map.set(url, timestamp as number);
        }
      }
    }
  } catch (error: unknown) {
    log.error('Error loading recently played:', error);
  }
  return map;
}

/**
 * Save recently played URLs to localStorage
 */
export function saveRecentlyPlayedToStorage(recentlyPlayed: Map<string, number>): void {
  try {
    const data: Record<string, number> = {};
    const now = Date.now();
    // Only save entries within cooldown period
    for (const [url, timestamp] of recentlyPlayed.entries()) {
      if (now - timestamp < TRACK_COOLDOWN_MS) {
        data[url] = timestamp;
      }
    }
    localStorage.setItem(RECENTLY_PLAYED_KEY, JSON.stringify(data));
  } catch (error: unknown) {
    log.error('Error saving recently played:', error);
  }
}

/**
 * Check if a URL was played recently (within cooldown period)
 */
export function wasPlayedRecently(
  recentlyPlayed: Map<string, number>,
  url: string
): { recent: boolean; minutesRemaining?: number } {
  const timestamp = recentlyPlayed.get(url);
  if (!timestamp) return { recent: false };

  const elapsed = Date.now() - timestamp;
  if (elapsed >= TRACK_COOLDOWN_MS) {
    recentlyPlayed.delete(url);
    return { recent: false };
  }

  const minutesRemaining = Math.ceil((TRACK_COOLDOWN_MS - elapsed) / 60000);
  return { recent: true, minutesRemaining };
}

// ============================================
// PLAY HISTORY (localStorage)
// ============================================

/**
 * Load play history from localStorage
 */
export function loadPlayHistoryFromStorage(): PlaylistHistoryEntry[] {
  try {
    const stored = localStorage.getItem(PLAYLIST_HISTORY_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (error: unknown) {
    log.error('Error loading play history:', error);
  }
  return [];
}

/**
 * Save play history to localStorage
 */
export function savePlayHistoryToStorage(history: PlaylistHistoryEntry[]): void {
  try {
    localStorage.setItem(PLAYLIST_HISTORY_KEY, JSON.stringify(history));
  } catch (error: unknown) {
    log.error('Error saving play history:', error);
  }
}

/**
 * Add an item to the play history array. Returns the updated array.
 * Prevents duplicate URLs - each URL only appears once in history.
 */
export function logToHistoryArray(
  history: PlaylistHistoryEntry[],
  item: GlobalPlaylistItem
): PlaylistHistoryEntry[] {
  const newHistory = [...history];

  // Check if URL already exists in history - no duplicates allowed
  const existingIndex = newHistory.findIndex(entry => entry.url === item.url);
  if (existingIndex >= 0) {
    // URL already in history - update playedAt timestamp and move to front
    const existing = newHistory.splice(existingIndex, 1)[0];
    existing.playedAt = new Date().toISOString();
    // Update other fields in case they've changed
    existing.title = item.title || existing.title;
    existing.thumbnail = item.thumbnail || existing.thumbnail;
    newHistory.unshift(existing);
    return newHistory;
  }

  const historyEntry: PlaylistHistoryEntry = {
    id: item.id,
    url: item.url,
    platform: item.platform,
    embedId: item.embedId,
    title: item.title,
    thumbnail: item.thumbnail,
    playedAt: new Date().toISOString()
  };

  // Add to beginning of history
  newHistory.unshift(historyEntry);

  // Trim to max size
  if (newHistory.length > MAX_HISTORY_SIZE) {
    return newHistory.slice(0, MAX_HISTORY_SIZE);
  }

  return newHistory;
}

/**
 * Log item to server-side master history (for auto-play across all users)
 */
export async function logToServerHistory(item: GlobalPlaylistItem): Promise<void> {
  try {
    await fetch('/api/playlist/history/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        item: {
          id: item.id,
          url: item.url,
          platform: item.platform,
          embedId: item.embedId,
          title: item.title,
          thumbnail: item.thumbnail,
          addedBy: item.addedBy,
          addedByName: item.addedByName
        }
      })
    });
  } catch (error: unknown) {
    log.error('Error logging to server history:', error);
  }
}

// ============================================
// AUTO-PLAY HELPERS
// ============================================

/**
 * Generate unique ID (duplicated here to avoid circular dependency)
 */
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

/**
 * Pick a random track from the local playlist server (H: drive MP3s).
 * Returns null if server is unavailable.
 */
export async function pickRandomFromLocalServer(
  lastPlayedUrl: string | null,
  recentlyPlayed: Map<string, number>
): Promise<GlobalPlaylistItem | null> {
  try {
    // Use authenticated proxy to prevent unauthenticated inventory disclosure
    const currentUser = window.firebaseAuth?.currentUser;
    const idToken = currentUser ? await currentUser.getIdToken() : null;

    const fetchHeaders: Record<string, string> = {};
    if (idToken) {
      fetchHeaders['Authorization'] = `Bearer ${idToken}`;
    }

    const response = await fetch('/api/playlist/server-list/', {
      headers: fetchHeaders,
      signal: AbortSignal.timeout(TIMEOUTS.SHORT)
    });

    if (!response.ok) {
      log.warn('Local playlist server returned', response.status);
      return null;
    }

    const data = await response.json();
    if (!data.files || data.files.length === 0) {
      log.warn('Local playlist server has no files');
      return null;
    }

    // Filter out recently played tracks
    const now = Date.now();
    const availableTracks = (data.files as ServerFileItem[]).filter((file) => {
      const url = `${LOCAL_PLAYLIST_SERVER}${file.url}`;
      if (url === lastPlayedUrl) return false;
      const timestamp = recentlyPlayed.get(url);
      if (!timestamp) return true;
      return (now - timestamp) >= TRACK_COOLDOWN_MS;
    });

    // Pick from available or all if all on cooldown
    const tracksToPickFrom = availableTracks.length > 0
      ? availableTracks
      : (data.files as ServerFileItem[]).filter((f) => `${LOCAL_PLAYLIST_SERVER}${f.url}` !== lastPlayedUrl);

    if (tracksToPickFrom.length === 0) {
      log.warn('No local tracks available');
      return null;
    }

    // Prefer tracks with thumbnails
    const tracksWithThumbs = tracksToPickFrom.filter((f) => f.thumbnail);
    const finalTracks = tracksWithThumbs.length > 0 ? tracksWithThumbs : tracksToPickFrom;

    const randomIndex = Math.floor(Math.random() * finalTracks.length);
    const selected = finalTracks[randomIndex];
    const url = `${LOCAL_PLAYLIST_SERVER}${selected.url}`;

    // Use track's own thumbnail if available, otherwise fallback
    const thumbnail = selected.thumbnail
      ? `${LOCAL_PLAYLIST_SERVER}${selected.thumbnail}`
      : AUDIO_THUMBNAIL_FALLBACK;

    return {
      id: generateId(),
      url: url,
      platform: 'direct',
      title: selected.name,
      thumbnail: thumbnail,
      duration: selected.duration || undefined,
      addedAt: new Date().toISOString(),
      addedBy: 'system',
      addedByName: 'Auto-Play'
    } as GlobalPlaylistItem & { duration?: number };
  } catch (error: unknown) {
    log.warn('Local playlist server error:', error);
    return null;
  }
}

/**
 * Pick a random track from history that hasn't been played recently.
 * Used for auto-play when queue is empty.
 * PRIORITY: Local server MP3s > YouTube history
 * Uses 60-minute cooldown and never repeats the last played track.
 */
export async function pickRandomFromHistory(
  lastPlayedUrl: string | null,
  recentlyPlayed: Map<string, number>,
  localPlayHistory: PlaylistHistoryEntry[]
): Promise<GlobalPlaylistItem | null> {
  // First, try the local playlist server (H: drive MP3s) - more reliable, no bot issues
  const localTrack = await pickRandomFromLocalServer(lastPlayedUrl, recentlyPlayed);
  if (localTrack) {
    return localTrack;
  }

  // Fallback to server-side YouTube history if local server is unavailable
  try {
    const response = await fetch('/api/playlist/history/');
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    const result = await response.json();
    if (result.success && result.items && result.items.length > 0) {
      const serverHistory = result.items as ServerHistoryItem[];

      // Filter out recently played tracks and the last played track
      const AUTO_PLAY_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes
      const now = Date.now();

      const availableTracks = serverHistory.filter((entry) => {
        // Never pick the track that just finished playing
        if (entry.url === lastPlayedUrl) return false;

        const timestamp = recentlyPlayed.get(entry.url);
        if (!timestamp) return true; // Never played recently, available
        const elapsed = now - timestamp;
        return elapsed >= AUTO_PLAY_COOLDOWN_MS; // Available if 60+ minutes since last play
      });

      if (availableTracks.length === 0) {
        // All tracks on cooldown - just pick a random one that isn't the last played
        const fallbackTracks = serverHistory.filter((entry) => entry.url !== lastPlayedUrl);
        if (fallbackTracks.length > 0) {
          const randomIndex = Math.floor(Math.random() * fallbackTracks.length);
          const selected = fallbackTracks[randomIndex];
          // Fetch real title if placeholder
          let title = selected.title;
          if (isPlaceholderTitle(title) && selected.embedId) {
            const realTitle = await fetchYouTubeTitle(selected.embedId);
            if (realTitle) title = realTitle;
          }

          return {
            id: generateId(),
            url: selected.url,
            platform: selected.platform as 'youtube' | 'vimeo' | 'soundcloud' | 'direct',
            embedId: selected.embedId,
            title: title,
            thumbnail: selected.thumbnail,
            addedAt: new Date().toISOString(),
            addedBy: 'system',
            addedByName: 'Auto-Play'
          };
        }
      }

      // Pick a random track from available tracks
      const randomIndex = Math.floor(Math.random() * availableTracks.length);
      const selected = availableTracks[randomIndex];

      // Fetch real title if it's a placeholder (e.g., "Track 1234")
      let title = selected.title;
      if (isPlaceholderTitle(title) && selected.embedId) {
        const realTitle = await fetchYouTubeTitle(selected.embedId);
        if (realTitle) {
          title = realTitle;
        }
      }

      return {
        id: generateId(),
        url: selected.url,
        platform: selected.platform as 'youtube' | 'vimeo' | 'soundcloud' | 'direct',
        embedId: selected.embedId,
        title: title,
        thumbnail: selected.thumbnail,
        addedAt: new Date().toISOString(),
        addedBy: 'system',
        addedByName: 'Auto-Play'
      };
    }
  } catch (error: unknown) {
    log.error('Error fetching server history:', error);
  }

  // Fallback to local history if server fails
  if (localPlayHistory.length > 0) {
    const randomIndex = Math.floor(Math.random() * localPlayHistory.length);
    const selected = localPlayHistory[randomIndex];

    // Fetch real title if it's a placeholder
    let title = selected.title;
    if (isPlaceholderTitle(title) && selected.embedId) {
      const realTitle = await fetchYouTubeTitle(selected.embedId);
      if (realTitle) title = realTitle;
    }

    return {
      id: generateId(),
      url: selected.url,
      platform: selected.platform as 'youtube' | 'vimeo' | 'soundcloud' | 'direct',
      embedId: selected.embedId,
      title: title,
      thumbnail: selected.thumbnail,
      addedAt: new Date().toISOString(),
      addedBy: 'system',
      addedByName: 'Auto-Play'
    };
  }

  return null;
}
