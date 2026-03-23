// src/lib/playlist-modal/index.ts
// Barrel re-export for playlist modal modules.

export type { PlaylistItem, ModalState, Logger } from './types';
export { injectModalHTML } from './dom';
export { startInitialization } from './api';
export { setupEventListeners, setupAuthListener, setupLifecycleEvents, setupPlaylistUpdateListener } from './events';
