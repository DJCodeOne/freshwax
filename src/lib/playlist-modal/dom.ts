// src/lib/playlist-modal/dom.ts
// Barrel re-export for all DOM sub-modules.
// External callers continue to import from './dom' — no changes needed.

// Pure formatting helpers
export {
  platformName,
  formatDuration,
  formatAddedDate,
  formatTimeAgo,
  sortPersonalItems,
  isPlaceholderTitle,
  getYouTubeId,
} from './dom-format';

// Modal HTML injection
export { injectModalHTML } from './dom-modal';

// DOM update functions (auth UI, position, now-playing, preview, timers, clipboard)
export {
  updateAuthUI,
  updatePositionIndicator,
  updateNowPlayingStrip,
  updateVideoPreview,
  refreshRecentlyPlayedTimes,
  startRecentlyPlayedTimeUpdates,
  stopRecentlyPlayedTimeUpdates,
  copyToClipboard,
} from './dom-state';

// Queue & personal playlist rendering
export {
  renderQueue,
  renderRecentlyPlayed,
  renderPersonalPlaylist,
  renderPersonalPlaylistPage,
} from './dom-render';
