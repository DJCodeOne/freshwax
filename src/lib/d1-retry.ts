// src/lib/d1-retry.ts
// Retry helper for D1 SQLITE_BUSY errors.
// D1 uses SQLite under the hood — concurrent writes can trigger SQLITE_BUSY.
// This helper retries with linear backoff (100ms * attempt) up to maxRetries times.

import { createLogger } from './api-utils';
import { TIMEOUTS } from './timeouts';

const log = createLogger('d1-retry');

/**
 * Execute a D1 operation with automatic retry on SQLITE_BUSY.
 * Other errors are thrown immediately without retry.
 *
 * @param fn - The async D1 operation to execute
 * @param maxRetries - Maximum number of retries (default 3)
 * @returns The result of the D1 operation
 */
export async function withD1Retry<T>(
  fn: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const isBusy = message.includes('SQLITE_BUSY');

      if (!isBusy || attempt > maxRetries) {
        throw error;
      }

      const delay = TIMEOUTS.D1_RETRY_BASE * attempt;
      log.warn(`SQLITE_BUSY on attempt ${attempt}/${maxRetries}, retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // Unreachable — the loop always returns or throws
  throw new Error('withD1Retry: unexpected exit');
}
