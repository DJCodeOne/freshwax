// src/lib/playlist-modal/api.ts
// Fetch calls and data loading/saving for the playlist modal.

import { createClientLogger } from '../client-logger';
import type { PlaylistModalState } from './types';
import { AUTH_STORAGE_KEY, CACHE_TTL } from './types';
import {
  updateAuthUI,
  renderRecentlyPlayed,
  updateDurationDisplay,
  stopDurationTimer,
} from './dom';

const log = createClientLogger('PlaylistModal');

// ─── Duration / YouTube API ─────────────────────────────────────────────────

/** Fetch video duration from YouTube API */
export async function fetchVideoDuration(platform: string, embedId: string): Promise<number | null> {
  if (platform === 'youtube' && embedId) {
    try {
      const response = await fetch(`/api/youtube/duration/?videoId=${embedId}`);
      if (response.ok) {
        const data = await response.json();
        if (data.duration) {
          return data.duration;
        }
      }
    } catch (error: unknown) {
      log.warn('Could not fetch duration:', error);
    }
  }
  return null;
}

/** Start the duration timer for a new track */
export async function startDurationTimer(
  state: PlaylistModalState,
  trackId: string,
  platform?: string,
  embedId?: string,
  trackStartedAt?: string | null
) {
  // If same track, don't restart
  if (trackId === state.lastTrackId && state.durationInterval) return;

  // Stop existing timer
  stopDurationTimer(state);

  state.lastTrackId = trackId;
  state.currentTrackStartTime = trackStartedAt ? new Date(trackStartedAt).getTime() : Date.now();
  state.currentTrackDuration = null;

  const durationEl = document.getElementById('previewDuration');
  if (durationEl) durationEl.textContent = '--:--';

  if (platform && embedId) {
    const duration = await fetchVideoDuration(platform, embedId);
    if (duration) {
      state.currentTrackDuration = duration;
    }
  }

  updateDurationDisplay(state);
  state.durationInterval = setInterval(() => updateDurationDisplay(state), 1000);
}

// ─── Playlist initialization ────────────────────────────────────────────────

/** Initialize playlist manager on page load */
export async function initPlaylist(state: PlaylistModalState) {
  if (state.playlistManager) return;

  const userInfo = window.currentUserInfo;
  state.currentUserId = userInfo?.id || null;
  state.isAuthenticated = userInfo?.loggedIn || false;

  // Dynamic import: PlaylistManager (~60KB) loads as a separate chunk
  const { PlaylistManager: PM } = await import('../playlist-manager');
  state.playlistManager = new PM('playlistPlayer');
  await state.playlistManager.initialize(state.currentUserId || undefined, userInfo?.displayName || userInfo?.name);

  updateAuthUI(state);

  // Expose globally for live-stream.js
  window.playlistManager = state.playlistManager;
}

// ─── Auth helpers ───────────────────────────────────────────────────────────

/** Save auth state to sessionStorage */
export function saveAuthState(state: PlaylistModalState) {
  if (state.isAuthenticated && state.currentUserId) {
    const userInfo = window.currentUserInfo;
    sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({
      id: state.currentUserId,
      name: userInfo?.displayName || userInfo?.name || 'User',
      loggedIn: true
    }));
  }
}

/** Check if auth is already ready (from window or sessionStorage) */
export function checkExistingAuth(state: PlaylistModalState): boolean {
  const userInfo = window.currentUserInfo;
  if (userInfo && userInfo.loggedIn === true && userInfo.id) {
    state.currentUserId = userInfo.id;
    state.isAuthenticated = true;
    saveAuthState(state);
    return true;
  }

  try {
    const stored = sessionStorage.getItem(AUTH_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed.loggedIn && parsed.id) {
        state.currentUserId = parsed.id;
        state.isAuthenticated = true;
        window.currentUserInfo = {
          loggedIn: true,
          id: parsed.id,
          name: parsed.name,
          displayName: parsed.name
        };
        return true;
      }
    }
  } catch (e: unknown) {
    log.warn('Could not read auth from sessionStorage:', e);
  }

  return false;
}

// ─── Recently played API ────────────────────────────────────────────────────

/** Update Recently Played list from server (global history) */
export async function updateRecentlyPlayed(state: PlaylistModalState) {
  const listContainer = document.getElementById('recentlyPlayedList');
  if (!listContainer) return;

  if (!state.recentlyPlayedCache) {
    listContainer.innerHTML = '<div class="recently-played-empty">Loading...</div>';
  }

  try {
    const now = Date.now();
    if (state.recentlyPlayedCache && (now - state.recentlyPlayedCacheTime) < CACHE_TTL) {
      renderRecentlyPlayed(listContainer, state.recentlyPlayedCache);
      return;
    }

    const response = await fetch('/api/playlist/history/');
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    const result = await response.json();

    if (result.success && result.items) {
      state.recentlyPlayedCache = result.items.slice(0, 10);
      state.recentlyPlayedCacheTime = now;
      renderRecentlyPlayed(listContainer, state.recentlyPlayedCache);
    } else {
      listContainer.innerHTML = '<div class="recently-played-empty">No tracks played yet</div>';
    }
  } catch (error: unknown) {
    log.warn('Could not fetch recently played:', error);
    const localHistory = state.playlistManager?.getPlayHistory() || [];
    if (localHistory.length > 0) {
      renderRecentlyPlayed(listContainer, localHistory.slice(0, 10));
    } else {
      listContainer.innerHTML = '<div class="recently-played-empty">No tracks played yet</div>';
    }
  }
}
