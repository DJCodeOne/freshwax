// src/lib/email.ts
// Shared email sending function with retry logic and D1 logging.
// All transactional emails should use sendResendEmail() instead of
// calling the Resend API directly.

import { fetchWithTimeout, createLogger } from './api-utils';

const log = createLogger('[email]');

// ============================================
// TYPES
// ============================================

export interface ResendEmailOptions {
  /** Resend API key (usually from env.RESEND_API_KEY) */
  apiKey: string;
  /** Sender address, e.g. 'Fresh Wax <noreply@freshwax.co.uk>' */
  from: string;
  /** Recipient(s) — single email or array */
  to: string | string[];
  /** Email subject line */
  subject: string;
  /** HTML body */
  html: string;
  /** Optional plain-text body */
  text?: string;
  /** Optional reply-to address */
  replyTo?: string;
  /** Optional BCC recipients */
  bcc?: string[];
  /** Template/source identifier for logging (e.g. 'order-confirmation', 'abandoned-cart') */
  template?: string;
  /** D1 database binding for logging (optional — logging is skipped if omitted) */
  db?: import('@cloudflare/workers-types').D1Database;
  /** Request timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
}

export interface ResendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
  /** Whether the email was sent on a retry attempt */
  retried?: boolean;
}

// ============================================
// CONSTANTS
// ============================================

const RESEND_API_URL = 'https://api.resend.com/emails';
const DEFAULT_TIMEOUT_MS = 10000;
const RATE_LIMIT_RETRY_DELAY_MS = 1000;
const SERVER_ERROR_RETRY_DELAY_MS = 2000;

// ============================================
// HELPERS
// ============================================

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Get the primary recipient email for logging purposes. */
function primaryRecipient(to: string | string[]): string {
  return Array.isArray(to) ? to[0] || '' : to;
}

// ============================================
// D1 EMAIL LOG
// ============================================

/**
 * Log an email send attempt to D1.
 * Non-blocking — failures here should never prevent the caller from proceeding.
 */
export async function logEmailToD1(
  db: import('@cloudflare/workers-types').D1Database,
  data: {
    messageId: string | null;
    toEmail: string;
    subject: string;
    template: string;
    status: 'sent' | 'failed' | 'retried';
    error?: string | null;
  }
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO email_logs (message_id, to_email, subject, template, status, error)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        data.messageId || null,
        data.toEmail,
        data.subject.slice(0, 500),
        data.template,
        data.status,
        data.error?.slice(0, 2000) || null
      )
      .run();
  } catch (err: unknown) {
    // Log but never throw — D1 logging is best-effort
    log.error('D1 log failed:', err instanceof Error ? err.message : err);
  }
}

// ============================================
// MAIN SEND FUNCTION
// ============================================

/**
 * Send an email via the Resend API with automatic retry logic.
 *
 * Retry policy:
 * - 429 (rate limit): retry once after 1 second
 * - 5xx (server error): retry once after 2 seconds
 * - Network/timeout error: retry once immediately
 *
 * Optionally logs results to D1 `email_logs` table when `db` is provided.
 */
export async function sendResendEmail(
  options: ResendEmailOptions
): Promise<ResendEmailResult> {
  const {
    apiKey,
    from,
    to,
    subject,
    html,
    text,
    replyTo,
    bcc,
    template = 'unknown',
    db,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const toEmail = primaryRecipient(to);

  if (!apiKey) {
    const error = 'RESEND_API_KEY not configured';
    log.error(error);
    if (db) {
      await logEmailToD1(db, { messageId: null, toEmail, subject, template, status: 'failed', error });
    }
    return { success: false, error };
  }

  if (!toEmail) {
    const error = 'No recipient email address';
    log.error(error);
    return { success: false, error };
  }

  const payload: Record<string, unknown> = {
    from,
    to: Array.isArray(to) ? to : to,
    subject,
    html,
  };
  if (text) payload.text = text;
  if (replyTo) payload.reply_to = replyTo;
  if (bcc && bcc.length > 0) payload.bcc = bcc;

  const fetchOptions: RequestInit = {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  };

  // ------------------------------------------
  // Attempt 1
  // ------------------------------------------
  let response: Response | null = null;
  let networkError: Error | null = null;

  try {
    response = await fetchWithTimeout(RESEND_API_URL, fetchOptions, timeoutMs);
  } catch (err: unknown) {
    networkError = err instanceof Error ? err : new Error(String(err));
  }

  // ------------------------------------------
  // Retry decision
  // ------------------------------------------
  let shouldRetry = false;
  let retryDelay = 0;
  let firstAttemptError = '';

  if (networkError) {
    // Network/timeout error — retry once immediately
    shouldRetry = true;
    retryDelay = 0;
    firstAttemptError = `Network error: ${networkError.message}`;
    log.warn(`Network error sending to ${toEmail} (template: ${template}): ${networkError.message} — retrying`);
  } else if (response && response.status === 429) {
    // Rate limited — retry after 1 second
    shouldRetry = true;
    retryDelay = RATE_LIMIT_RETRY_DELAY_MS;
    firstAttemptError = 'Rate limited (429)';
    log.warn(`Rate limited sending to ${toEmail} (template: ${template}) — retrying in ${retryDelay}ms`);
  } else if (response && response.status >= 500) {
    // Server error — retry after 2 seconds
    shouldRetry = true;
    retryDelay = SERVER_ERROR_RETRY_DELAY_MS;
    firstAttemptError = `Server error (${response.status})`;
    log.warn(`Server error ${response.status} sending to ${toEmail} (template: ${template}) — retrying in ${retryDelay}ms`);
  }

  // ------------------------------------------
  // Attempt 2 (if needed)
  // ------------------------------------------
  if (shouldRetry) {
    if (retryDelay > 0) {
      await sleep(retryDelay);
    }

    response = null;
    networkError = null;

    try {
      response = await fetchWithTimeout(RESEND_API_URL, fetchOptions, timeoutMs);
    } catch (err: unknown) {
      networkError = err instanceof Error ? err : new Error(String(err));
    }

    // If the retry also failed with a network error
    if (networkError) {
      const error = `Retry failed — ${firstAttemptError}; then: ${networkError.message}`;
      log.error(`FAILED sending to ${toEmail} (template: ${template}): ${error}`);

      if (db) {
        await logEmailToD1(db, { messageId: null, toEmail, subject, template, status: 'failed', error });
      }
      return { success: false, error, retried: true };
    }
  }

  // ------------------------------------------
  // Process response
  // ------------------------------------------
  if (!response) {
    // Should not happen, but defensive
    const error = 'No response from Resend API';
    log.error(`${error} for ${toEmail} (template: ${template})`);
    if (db) {
      await logEmailToD1(db, { messageId: null, toEmail, subject, template, status: 'failed', error });
    }
    return { success: false, error };
  }

  if (response.ok) {
    let messageId: string | undefined;
    try {
      const result = await response.json() as { id?: string };
      messageId = result.id;
    } catch {
      // Non-critical — we still consider it a success if the HTTP status was 2xx
    }

    const status = shouldRetry ? 'retried' : 'sent';
    log.info(
      `${status === 'retried' ? 'RETRIED+SENT' : 'SENT'} to=${toEmail} template=${template} messageId=${messageId || 'unknown'}`
    );

    if (db) {
      await logEmailToD1(db, {
        messageId: messageId || null,
        toEmail,
        subject,
        template,
        status,
        error: shouldRetry ? firstAttemptError : null,
      });
    }

    return { success: true, messageId, retried: shouldRetry };
  }

  // Non-retryable error or retry still failed
  let errorBody = '';
  try {
    errorBody = await response.text();
  } catch {
    errorBody = `HTTP ${response.status}`;
  }

  const finalError = shouldRetry
    ? `Retry failed — ${firstAttemptError}; then: HTTP ${response.status} ${errorBody}`
    : `HTTP ${response.status}: ${errorBody}`;

  log.error(
    `FAILED to=${toEmail} template=${template} status=${response.status} error=${errorBody}`
  );

  if (db) {
    await logEmailToD1(db, {
      messageId: null,
      toEmail,
      subject,
      template,
      status: 'failed',
      error: finalError,
    });
  }

  return { success: false, error: finalError, retried: shouldRetry };
}
