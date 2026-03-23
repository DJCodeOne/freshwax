/**
 * Release plate API — barrel re-export.
 * Split into focused modules: ratings, wishlist, preorder, nyop.
 * All existing imports from './release-plate/api' continue to work unchanged.
 */
export { initRatingSystem, fetchUserRatings } from './ratings';
export { initWishlistSystem } from './wishlist';
export { initPreorderSystem } from './preorder';
export { initNYOPSystem } from './nyop';
