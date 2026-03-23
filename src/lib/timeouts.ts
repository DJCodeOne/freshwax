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
} as const;
