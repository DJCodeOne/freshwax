/**
 * Release plate orchestrator — thin wrapper that wires together release-plate sub-modules.
 * Sub-modules: release-plate/cache, release-plate/api, release-plate/player, release-plate/ui
 */
import { FWCache } from './release-plate/cache';
import { initRatingSystem, fetchUserRatings, initWishlistSystem, initPreorderSystem, initNYOPSystem } from './release-plate/api';
import { initReleasePlayer } from './release-plate/player';
import { initShareSystem, initCartListeners, resetShareInit } from './release-plate/ui';

// Cart listeners must be attached once at module level (not inside init)
// because they use document-level event delegation
initCartListeners();

function initAll() {
  FWCache.cleanup();
  initReleasePlayer();
  initRatingSystem();
  initShareSystem();
  initWishlistSystem();
  initPreorderSystem();
  initNYOPSystem();
  // Fetch user's own ratings (async, runs after auth is ready)
  fetchUserRatings();
}

export function init() {
  // Reset initialization flags for page transitions
  resetShareInit();
  initAll();
}
