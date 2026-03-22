/**
 * Release plate barrel — re-exports all release-plate sub-modules.
 */
export { FWCache, getAuthUser, sanitizeComment, formatDate } from './cache';
export { initRatingSystem, fetchUserRatings, initWishlistSystem, initPreorderSystem, initNYOPSystem } from './api';
export { initReleasePlayer } from './player';
export { initShareSystem, initCartListeners, shareInitialized, resetShareInit } from './ui';
