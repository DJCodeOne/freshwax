// src/lib/playlist-modal-init.ts
// Lazy-loaded playlist modal initialization module.
// Extracted from PlaylistModal.astro <script> to enable dynamic import
// and reduce initial JS payload on the live page (~78KB+ savings).
//
// This file is a thin orchestrator that imports focused sub-modules:
//   - playlist-modal/types.ts  — interfaces, type definitions, state factory
//   - playlist-modal/dom.ts    — DOM manipulation, rendering, formatting
//   - playlist-modal/api.ts    — fetch calls, auth, duration timer
//   - playlist-modal/events.ts — event handlers, keyboard shortcuts, lifecycle

import { createClientLogger } from './client-logger';
import { injectModalHTML } from './playlist-modal/dom';
import { startRecentlyPlayedTimeUpdates } from './playlist-modal/dom';
import { startInitialization } from './playlist-modal/api';
import {
  setupEventListeners,
  setupAuthListener,
  setupLifecycleEvents,
  handlePlaylistUpdate,
} from './playlist-modal/events';
import type { ModalState } from './playlist-modal/types';

const log = createClientLogger('PlaylistModal');

// Guard against multiple initializations
let _initialized = false;

export function initPlaylistModal() {
  if (_initialized) return;
  _initialized = true;

  // Inject the full modal HTML into the placeholder container
  injectModalHTML();

  // Create shared mutable state for all sub-modules
  const state: ModalState = {
    log,
    playlistManager: null,
    isStopped: false,
    currentUserId: null,
    isAuthenticated: false,
    hasInitializedThisPage: false,
    listenersAttached: false,
    isAddingToPlaylist: false,

    durationInterval: null,
    currentTrackStartTime: null,
    currentTrackDuration: null,
    lastTrackId: null,

    currentPlaylistPage: 1,
    cachedPersonalItems: [],
    cachedUserTracksInQueue: 0,
    currentSortOrder: 'recent',

    recentlyPlayedCache: null,
    recentlyPlayedCacheTime: 0,

    recentlyPlayedTimeInterval: null,
  };

  // Wire up auth event listener
  setupAuthListener(state);

  // Wire up playlistUpdate event listener (use stable ref to avoid duplicate listeners)
  if ((window as Record<string, unknown>)._playlistModalUpdateHandler) {
    window.removeEventListener('playlistUpdate', (window as Record<string, unknown>)._playlistModalUpdateHandler as EventListener);
  }
  const playlistUpdateHandler = (event: Event) => handlePlaylistUpdate(state, event);
  (window as Record<string, unknown>)._playlistModalUpdateHandler = playlistUpdateHandler;
  window.addEventListener('playlistUpdate', playlistUpdateHandler);

  // Wire up lifecycle events for View Transitions
  setupLifecycleEvents(state, () => { _initialized = false; });

  // Start the recently-played time-update interval
  startRecentlyPlayedTimeUpdates(state);

  // Run initialization immediately (astro:page-load may have already fired)
  startInitialization(state);
  setupEventListeners(state);
}
