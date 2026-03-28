// src/lib/playlist-modal/events-handlers.ts
// Playlist update event handler and cleanup for the playlist modal.

import type { ModalState } from './types';
import {
  updateAuthUI,
  updatePositionIndicator,
  updateNowPlayingStrip,
  updateVideoPreview,
  renderQueue,
  renderRecentlyPlayed,
  renderPersonalPlaylist,
  stopRecentlyPlayedTimeUpdates,
} from './dom';
import {
  updateRecentlyPlayed,
  stopDurationTimer,
} from './api';

/** Handle playlist update events from PlaylistManager */
export function handlePlaylistUpdate(state: ModalState, event: Event): void {
  const {
    queue,
    currentIndex,
    isPlaying,
    queueSize,
    isAuthenticated: authState,
    userId,
    userQueuePosition,
    userTracksInQueue,
    isUsersTurn,
    currentDj,
    personalPlaylist,
    trackStartedAt,
    recentlyPlayed
  } = (event as CustomEvent).detail;

  if (authState !== undefined) {
    state.isAuthenticated = authState;
    state.currentUserId = userId || null;
    updateAuthUI(state);
  }

  updatePositionIndicator(state, userQueuePosition, isUsersTurn, queueSize);
  renderQueue(state, queue, currentIndex);

  const controlsDiv = document.getElementById('playlistControls');
  if (queueSize > 0) {
    controlsDiv?.classList.remove('hidden');
  } else {
    controlsDiv?.classList.add('hidden');
  }

  const statusText = document.getElementById('playlistStatusText');
  if (statusText && queueSize > 0) {
    const djName = currentDj?.userName || 'Unknown';
    statusText.textContent = `Selector: ${djName}`;
  }

  updateNowPlayingStrip(
    queue,
    currentIndex,
    currentDj,
    trackStartedAt,
    (item, dj, started) => updateVideoPreview(state, item, dj, started, () => stopDurationTimer(state)),
  );

  const queueCount = document.getElementById('queueCount');
  if (queueCount) {
    queueCount.textContent = `${queueSize}/10`;
  }

  state.isStopped = !isPlaying;

  renderPersonalPlaylist(state, personalPlaylist || [], userTracksInQueue || 0);

  if (recentlyPlayed && recentlyPlayed.length > 0) {
    state.recentlyPlayedCache = recentlyPlayed;
    state.recentlyPlayedCacheTime = Date.now();
    const listContainer = document.getElementById('recentlyPlayedList');
    if (listContainer) {
      renderRecentlyPlayed(state, listContainer, recentlyPlayed);
    }
  } else {
    updateRecentlyPlayed(state);
  }
}

/** Cleanup function to properly destroy the playlist manager */
export function cleanupPlaylistManager(state: ModalState): void {
  stopRecentlyPlayedTimeUpdates(state);
  if (state.playlistManager) {
    try {
      state.playlistManager.destroy();
    } catch (e: unknown) {
      state.log.error('Error destroying manager:', e);
    }
  }
  state.playlistManager = null;
  window.playlistManager = null;
  state.hasInitializedThisPage = false;
  state.listenersAttached = false;
}
