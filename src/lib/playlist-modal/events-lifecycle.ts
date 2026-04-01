// src/lib/playlist-modal/events-lifecycle.ts
// Auth listener, lifecycle events, and playlist update listener for the playlist modal.

import type { ModalState } from './types';
import { updateAuthUI } from './dom';
import {
  saveAuthState,
  initPlaylist,
  startInitialization,
} from './api';
import { setupEventListeners } from './events-setup';
import { handlePlaylistUpdate, cleanupPlaylistManager } from './events-handlers';

/** Wire up userAuthReady event listener */
export function setupAuthListener(state: ModalState): void {
  document.addEventListener('userAuthReady', (e: Event) => {
    const { userInfo } = (e as CustomEvent).detail;
    if (userInfo && userInfo.loggedIn) {
      state.currentUserId = userInfo.id;
      state.isAuthenticated = true;
      saveAuthState(state);

      updateAuthUI(state);

      if (!state.playlistManager) {
        initPlaylist(state);
      } else {
        state.playlistManager.initialize(state.currentUserId || undefined, userInfo.displayName || userInfo.name);
      }
    }
  });
}

/** Wire up lifecycle events (View Transitions, page load) */
export function setupLifecycleEvents(
  state: ModalState,
  resetInitializedFlag: () => void,
): void {
  function handleBeforeSwap() {
    cleanupPlaylistManager(state);
    resetInitializedFlag();
  }

  function handlePageLoad() {
    const playlistContainer = document.getElementById('playlistPlayer');
    if (!playlistContainer) {
      return;
    }

    cleanupPlaylistManager(state);
    startInitialization(state);
    setupEventListeners(state);
  }

  document.removeEventListener('astro:before-swap', handleBeforeSwap);
  document.addEventListener('astro:before-swap', handleBeforeSwap);
  document.removeEventListener('astro:page-load', handlePageLoad);
  document.addEventListener('astro:page-load', handlePageLoad);
}

/** Wire up playlistUpdate event listener */
export function setupPlaylistUpdateListener(state: ModalState): void {
  // Remove previous handler using stable reference stored on state
  if ((state as Record<string, unknown>)._playlistUpdateHandler) {
    window.removeEventListener('playlistUpdate', (state as Record<string, unknown>)._playlistUpdateHandler as EventListener);
  }
  const stableHandler = (event: Event) => handlePlaylistUpdate(state, event);
  (state as Record<string, unknown>)._playlistUpdateHandler = stableHandler;
  window.addEventListener('playlistUpdate', stableHandler);
}
