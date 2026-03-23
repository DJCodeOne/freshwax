// src/lib/playlist-modal/api.ts
// Fetch calls, auth logic, and duration timer for the playlist modal.

import { TIMEOUTS } from '../timeouts';
import {
  RECENTLY_PLAYED_CACHE_TTL,
  AUTH_MAX_ATTEMPTS,
  AUTH_POLL_INTERVAL,
  AUTH_LATE_CHECK_INTERVAL,
  AUTH_LATE_MAX_CHECKS,
} from '../constants/limits';
import type { PlaylistItem, ModalState } from './types';
import { formatDuration, renderRecentlyPlayed, updateAuthUI } from './dom';

// Session storage key for persisting auth state
const AUTH_STORAGE_KEY = 'freshwax_playlist_auth';

// ---------------------------------------------------------------------------
// Duration timer
// ---------------------------------------------------------------------------

/** Fetch video duration from YouTube API */
export async function fetchVideoDuration(state: ModalState, platform: string, embedId: string): Promise<number | null> {
  if (platform === 'youtube' && embedId) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.API_EXTENDED);

      const response = await fetch(`/api/youtube/duration/?videoId=${embedId}`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        if (data.duration) {
          return data.duration;
        }
      }
    } catch (error: unknown) {
      state.log.warn('Could not fetch duration:', error);
    }
  }
  return null;
}

/** Update the duration display (countdown) */
export function updateDurationDisplay(state: ModalState): void {
  const durationEl = document.getElementById('previewDuration');
  if (!durationEl || !state.currentTrackStartTime) return;

  const elapsed = Math.floor((Date.now() - state.currentTrackStartTime) / 1000);

  if (state.currentTrackDuration) {
    const remaining = state.currentTrackDuration - elapsed;
    durationEl.textContent = formatDuration(remaining);
  } else {
    durationEl.textContent = formatDuration(elapsed);
  }
}

/** Start the duration timer for a new track */
export async function startDurationTimer(
  state: ModalState,
  trackId: string,
  platform?: string,
  embedId?: string,
  trackStartedAt?: string | null,
): Promise<void> {
  if (trackId === state.lastTrackId && state.durationInterval) return;

  stopDurationTimer(state);

  state.lastTrackId = trackId;
  state.currentTrackStartTime = trackStartedAt ? new Date(trackStartedAt).getTime() : Date.now();
  state.currentTrackDuration = null;

  const durationEl = document.getElementById('previewDuration');
  if (durationEl) durationEl.textContent = '--:--';

  if (platform && embedId) {
    const duration = await fetchVideoDuration(state, platform, embedId);
    if (duration) {
      state.currentTrackDuration = duration;
    }
  }

  updateDurationDisplay(state);
  state.durationInterval = setInterval(() => updateDurationDisplay(state), TIMEOUTS.TICK);
}

/** Stop the duration timer */
export function stopDurationTimer(state: ModalState): void {
  if (state.durationInterval) {
    clearInterval(state.durationInterval);
    state.durationInterval = null;
  }
  state.currentTrackStartTime = null;
  state.currentTrackDuration = null;
  const durationEl = document.getElementById('previewDuration');
  if (durationEl) durationEl.textContent = '--:--';
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/** Save auth state to sessionStorage */
export function saveAuthState(state: ModalState): void {
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
export function checkExistingAuth(state: ModalState): boolean {
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
    state.log.warn('Could not read auth from sessionStorage:', e);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Playlist initialization
// ---------------------------------------------------------------------------

/** Initialize playlist on page load */
export async function initPlaylist(state: ModalState): Promise<void> {
  if (state.playlistManager) return;

  const userInfo = window.currentUserInfo;
  state.currentUserId = userInfo?.id || null;
  state.isAuthenticated = userInfo?.loggedIn || false;

  const { PlaylistManager: PM } = await import('../playlist-manager');
  state.playlistManager = new PM('playlistPlayer');
  await state.playlistManager.initialize(state.currentUserId || undefined, userInfo?.displayName || userInfo?.name);

  updateAuthUI(state);

  window.playlistManager = state.playlistManager;
}

/** Initialize - check existing auth first, then wait if needed */
export function startInitialization(state: ModalState): void {
  if (state.hasInitializedThisPage) {
    return;
  }
  state.hasInitializedThisPage = true;

  if (checkExistingAuth(state)) {
    updateAuthUI(state);
    initPlaylist(state);
    return;
  }

  let attempts = 0;
  const maxAttempts = AUTH_MAX_ATTEMPTS;

  function checkAuth() {
    attempts++;
    const userInfo = window.currentUserInfo;

    if (userInfo && userInfo.loggedIn === true && userInfo.id) {
      state.currentUserId = userInfo.id;
      state.isAuthenticated = true;
      saveAuthState(state);
      updateAuthUI(state);
      initPlaylist(state);
      return;
    }

    if (attempts >= maxAttempts) {
      state.currentUserId = null;
      state.isAuthenticated = false;
      updateAuthUI(state);
      initPlaylist(state);

      let lateChecks = 0;
      const lateAuthCheck = setInterval(() => {
        lateChecks++;
        const userInfo = window.currentUserInfo;
        if (userInfo && userInfo.loggedIn === true && userInfo.id && !state.isAuthenticated) {
          state.currentUserId = userInfo.id;
          state.isAuthenticated = true;
          updateAuthUI(state);
          saveAuthState(state);
          clearInterval(lateAuthCheck);
        }
        if (lateChecks >= AUTH_LATE_MAX_CHECKS) {
          clearInterval(lateAuthCheck);
        }
      }, AUTH_LATE_CHECK_INTERVAL);
      return;
    }

    setTimeout(checkAuth, AUTH_POLL_INTERVAL);
  }

  checkAuth();
}

// ---------------------------------------------------------------------------
// Recently played
// ---------------------------------------------------------------------------

/** Update Recently Played list from server (global history) */
export async function updateRecentlyPlayed(state: ModalState): Promise<void> {
  const listContainer = document.getElementById('recentlyPlayedList');
  if (!listContainer) return;

  if (!state.recentlyPlayedCache) {
    listContainer.innerHTML = '<div class="recently-played-empty">Loading...</div>';
  }

  try {
    const now = Date.now();
    if (state.recentlyPlayedCache && (now - state.recentlyPlayedCacheTime) < RECENTLY_PLAYED_CACHE_TTL) {
      renderRecentlyPlayed(state, listContainer, state.recentlyPlayedCache);
      return;
    }

    const historyController = new AbortController();
    const historyTimeoutId = setTimeout(() => historyController.abort(), TIMEOUTS.API_EXTENDED);

    const response = await fetch('/api/playlist/history/', {
      signal: historyController.signal
    });
    clearTimeout(historyTimeoutId);

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    const result = await response.json();

    if (result.success && result.items) {
      state.recentlyPlayedCache = result.items.slice(0, 10);
      state.recentlyPlayedCacheTime = now;
      renderRecentlyPlayed(state, listContainer, state.recentlyPlayedCache);
    } else {
      listContainer.innerHTML = '<div class="recently-played-empty">No tracks played yet</div>';
    }
  } catch (error: unknown) {
    state.log.warn('Could not fetch recently played:', error);
    const localHistory = state.playlistManager?.getPlayHistory() || [];
    if (localHistory.length > 0) {
      renderRecentlyPlayed(state, listContainer, localHistory.slice(0, 10) as PlaylistItem[]);
    } else {
      listContainer.innerHTML = '<div class="recently-played-empty">No tracks played yet</div>';
    }
  }
}
