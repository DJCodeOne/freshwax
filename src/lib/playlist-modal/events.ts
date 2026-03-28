// src/lib/playlist-modal/events.ts
// Barrel re-export for all event sub-modules.
// External callers continue to import from './events' — no changes needed.

// Focus trap helpers
export { trapFocus, removeFocusTrap } from './events-focus';

// Main DOM event listener setup
export { setupEventListeners } from './events-setup';

// Playlist update handler and cleanup
export { handlePlaylistUpdate, cleanupPlaylistManager } from './events-handlers';

// Auth listener, lifecycle events, and playlist update listener
export { setupAuthListener, setupLifecycleEvents, setupPlaylistUpdateListener } from './events-lifecycle';
