// src/lib/error-alerting.ts
// Lightweight error spike alerting via webhook (Discord/Slack compatible)
// Queries D1 error_logs for recent error count and sends a webhook if threshold exceeded.
// Uses KV to debounce alerts (max one alert per cooldown period).

import { fetchWithTimeout } from './api-utils';
import { TIMEOUTS } from './timeouts';

interface AlertEnv {
  DB?: import('@cloudflare/workers-types').D1Database;
  CACHE?: import('@cloudflare/workers-types').KVNamespace;
  ALERT_WEBHOOK_URL?: string;
}

/** Number of errors in the last hour that triggers an alert */
const ERROR_THRESHOLD = 10;

/** Cooldown between alerts — avoid spamming (1 hour in seconds) */
const ALERT_COOLDOWN_SECONDS = 3600;

/** KV key for alert debounce */
const ALERT_COOLDOWN_KEY = 'error-alert:last-sent';

/**
 * Check recent error count and send a webhook alert if threshold exceeded.
 * Designed to be called fire-and-forget after logging an error.
 * Safe to call frequently — KV debounce prevents alert spam.
 *
 * @returns true if an alert was sent, false otherwise
 */
export async function checkAndAlertErrorSpike(env: AlertEnv | undefined): Promise<boolean> {
  try {
    const webhookUrl = env?.ALERT_WEBHOOK_URL;
    if (!webhookUrl) return false; // Alerting not configured — skip silently

    const db = env?.DB;
    const kv = env?.CACHE;
    if (!db) return false; // No D1 — can't count errors

    // Check KV cooldown first (cheapest operation)
    if (kv) {
      const lastSent = await kv.get(ALERT_COOLDOWN_KEY);
      if (lastSent) return false; // Still in cooldown — skip
    }

    // Count errors in the last hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const result = await db
      .prepare('SELECT COUNT(*) as count FROM error_logs WHERE created_at > ?')
      .bind(oneHourAgo)
      .first<{ count: number }>();

    const errorCount = result?.count ?? 0;
    if (errorCount < ERROR_THRESHOLD) return false; // Below threshold

    // Get top 3 most frequent error fingerprints for context
    const topErrors = await db
      .prepare(
        `SELECT message, fingerprint, COUNT(*) as occurrences
         FROM error_logs WHERE created_at > ?
         GROUP BY fingerprint ORDER BY occurrences DESC LIMIT 3`
      )
      .bind(oneHourAgo)
      .all<{ message: string; fingerprint: string; occurrences: number }>();

    // Build webhook payload (Discord-compatible embed format, also works with Slack)
    const topErrorLines = (topErrors.results || [])
      .map((e, i) => `${i + 1}. **${e.occurrences}x** — ${e.message.slice(0, 100)}`)
      .join('\n');

    const payload = {
      // Discord format
      embeds: [{
        title: 'Error Spike Alert',
        description: `**${errorCount}** errors in the last hour (threshold: ${ERROR_THRESHOLD})`,
        color: 0xff4444, // Red
        fields: topErrorLines ? [{
          name: 'Top errors',
          value: topErrorLines,
        }] : [],
        timestamp: new Date().toISOString(),
      }],
      // Slack fallback (uses text field)
      text: `Error Spike Alert: ${errorCount} errors in the last hour (threshold: ${ERROR_THRESHOLD})`,
    };

    // Send webhook with timeout to avoid blocking the caller
    const response = await fetchWithTimeout(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, TIMEOUTS.API);

    // Set cooldown in KV to prevent spam
    if (kv && response.ok) {
      await kv.put(ALERT_COOLDOWN_KEY, new Date().toISOString(), {
        expirationTtl: ALERT_COOLDOWN_SECONDS,
      });
    }

    return response.ok;
  } catch (_e: unknown) {
    /* intentional: alerting must never throw — swallow all failures */
    return false;
  }
}
