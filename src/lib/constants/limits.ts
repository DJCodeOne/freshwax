// src/lib/constants/limits.ts
// Shared business-logic constants — only values that appear in 2+ places

/** Maximum retry attempts for optimistic concurrency conflicts (Firestore, stock, gift cards) */
export const MAX_RETRIES = 3;

/** Maximum consecutive playback errors before stopping (playlist manager) */
export const MAX_CONSECUTIVE_ERRORS = 3;

/** Items per page for client-side pagination (playlist modal, etc.) */
export const ITEMS_PER_PAGE = 20;

/** Maximum items in a personal playlist */
export const MAX_PLAYLIST_ITEMS = 500;

/** Maximum tracks a single DJ can have in the queue at once */
export const MAX_DJ_QUEUE_TRACKS = 2;

/** Recently played cache TTL for client-side playlist modal (30 seconds) */
export const RECENTLY_PLAYED_CACHE_TTL = 30000;

/** Auth session cache TTL in sessionStorage (30 minutes) */
export const AUTH_CACHE_TTL = 1800000;

/** Auth polling: max attempts before giving up (3 seconds at 100ms intervals) */
export const AUTH_MAX_ATTEMPTS = 30;

/** Auth polling: interval between auth state checks (100ms) */
export const AUTH_POLL_INTERVAL = 100;

/** Auth polling: late check interval after initial timeout (500ms) */
export const AUTH_LATE_CHECK_INTERVAL = 500;

/** Auth polling: max late checks (20 = 10 seconds at 500ms) */
export const AUTH_LATE_MAX_CHECKS = 20;
