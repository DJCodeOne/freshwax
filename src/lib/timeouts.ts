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
} as const;
