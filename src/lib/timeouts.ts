// src/lib/timeouts.ts
// Centralized timeout constants — replaces magic numbers across API and lib code

export const TIMEOUTS = {
  /** Standard API call timeout (10 seconds) */
  API: 10000,
  /** Long-running operations like file downloads (30 seconds) */
  LONG: 30000,
  /** Quick health checks and lightweight requests (5 seconds) */
  SHORT: 5000,
  /** Cron jobs and session expiry (60 seconds) */
  CRON: 60000,
  /** UI toast/success/error notification auto-hide (3 seconds) */
  TOAST: 3000,
  /** Extended toast for PDF export and error messages (4 seconds) */
  TOAST_LONG: 4000,
  /** Input debounce delay (300 milliseconds) */
  DEBOUNCE: 300,
  /** CSS fade-out and animation transitions (500 milliseconds) */
  ANIMATION: 500,
  /** Extended API calls — payment processing, media metadata, history fetch (15 seconds) */
  API_EXTENDED: 15000,
  /** Duration display and countdown update interval (1 second) */
  TICK: 1000,
  /** Recently played time refresh interval (60 seconds) */
  RECENTLY_PLAYED_REFRESH: 60000,
  /** Safety auto-hide for loading overlays (15 seconds) */
  SAFETY_OVERLAY: 15000,
  /** oEmbed metadata fetch timeout (8 seconds) */
  OEMBED: 8000,
  /** Bot welcome/tune comment delay (1.5 seconds) */
  BOT_DELAY: 1500,
  /** Rating debounce cooldown (2 seconds) */
  RATING_DEBOUNCE: 2000,
  /** Batch operation rate limit delay (200 milliseconds) */
  BATCH_DELAY: 200,
  /** Quick polling/DOM cleanup interval (100 milliseconds) */
  POLL: 100,
  /** Retry delay after transient server error (500 milliseconds) */
  RETRY_DELAY: 500,
  /** Rate limit retry delay for email sending (1 second) */
  RATE_LIMIT_RETRY: 1000,
  /** Server error retry delay for email sending (2 seconds) */
  SERVER_ERROR_RETRY: 2000,
  /** D1 SQLITE_BUSY retry base delay — multiplied by attempt number (100 milliseconds) */
  D1_RETRY_BASE: 100,
  /** PayPal transient failure retry delay (2 seconds) */
  PAYPAL_RETRY: 2000,
  /** Firebase rate limit (429) retry delay (1 second) */
  FIREBASE_RATE_LIMIT_RETRY: 1000,
} as const;

/** KV expirationTtl values in seconds */
export const KV_TTL = {
  /** 1 day (86400 seconds) */
  ONE_DAY: 86400,
  /** 7 days (604800 seconds) */
  ONE_WEEK: 604800,
  /** 30 days (2592000 seconds) */
  ONE_MONTH: 30 * 24 * 60 * 60,
  /** 1 year (31536000 seconds) */
  ONE_YEAR: 365 * 24 * 60 * 60,
} as const;
