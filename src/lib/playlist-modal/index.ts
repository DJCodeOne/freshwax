// src/lib/playlist-modal/index.ts
// Barrel re-export of the public API for the playlist modal modules.

export type { PlaylistItem, PlaylistModalState, SortOrder } from './types';
export { ITEMS_PER_PAGE, MAX_ITEMS, CACHE_TTL, AUTH_STORAGE_KEY, createDefaultState } from './types';

export {
  platformName,
  formatDuration,
  formatAddedDate,
  formatTimeAgo,
  sortPersonalItems,
  isPlaceholderTitle,
  getYouTubeId,
  trapFocus,
  removeFocusTrap,
  injectModalHTML,
  updateDurationDisplay,
  stopDurationTimer,
  updateAuthUI,
  updatePositionIndicator,
  updateNowPlayingStrip,
  updateVideoPreview,
  renderRecentlyPlayed,
  refreshRecentlyPlayedTimes,
  startRecentlyPlayedTimeUpdates,
  stopRecentlyPlayedTimeUpdates,
  renderQueue,
  renderPersonalPlaylist,
  renderPersonalPlaylistPage,
} from './dom';

export {
  fetchVideoDuration,
  startDurationTimer,
  initPlaylist,
  saveAuthState,
  checkExistingAuth,
  updateRecentlyPlayed,
} from './api';

export {
  handlePlaylistUpdate,
  setupEventListeners,
  startInitialization,
  cleanupPlaylistManager,
} from './events';
