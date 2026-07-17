// src/lib/newsletter-consent.ts
// Records marketing consent captured outside the footer signup form — at
// registration and at checkout.
//
// WHY THIS EXISTS: the `users` collection has never carried a consent field, so
// the user base is not a lawful marketing audience under UK GDPR/PECR. This is
// the forward fix — every consent from here on is captured explicitly, with the
// evidence (timestamp, source, IP) the ICO would expect to see. It does NOT
// retrospectively legitimise anyone who signed up before it existed.
//
// Consent captured here is an explicit, unticked-by-default opt-in on our own
// form, so the subscriber goes straight to `active` rather than through the
// footer form's double opt-in — the address is separately proven by the account
// email-verification flow. The consent evidence written is identical either way.

import { getDocument, createDocumentIfNotExists, updateDocument } from './firebase-rest';
import { createLogger } from './api-utils';
import { normalizeEmail } from './newsletter-tokens';

const log = createLogger('[newsletter-consent]');

/** Doc-id scheme must match newsletter/subscribe.ts — one doc per address. */
export function emailToDocId(email: string): string {
  return normalizeEmail(email).replace(/[.@]/g, '_');
}

export interface ConsentRecord {
  email: string;
  /** Where the tick happened — 'register' | 'checkout' | etc. Stored as evidence. */
  source: string;
  name?: string;
  /** Client identifier for the consent audit trail. */
  ip?: string;
}

/**
 * Upsert an active subscriber from an explicit consent tick.
 *
 * Best-effort by design: a newsletter write must never fail a registration or
 * an order. Returns true only if consent was actually recorded.
 */
export async function recordMarketingConsent(
  record: ConsentRecord
): Promise<boolean> {
  const email = normalizeEmail(record.email);
  if (!email) return false;

  const id = emailToDocId(email);
  const now = new Date().toISOString();

  const consentFields = {
    consentTimestamp: now,
    consentSource: record.source,
    consentIp: record.ip || '',
    updatedAt: now,
  };

  try {
    let existing = null;
    try {
      existing = await getDocument('subscribers', id);
    } catch (_e: unknown) {
      /* non-critical: treat an unreadable lookup as "not present" and try to create */
    }

    if (existing) {
      // Already active: keep the ORIGINAL consent evidence. Overwriting it with
      // today's date would destroy the record of when they actually opted in.
      if (existing.status === 'active') return true;

      // Previously unsubscribed or never confirmed — this is fresh consent.
      await updateDocument('subscribers', id, {
        ...consentFields,
        status: 'active',
        confirmedAt: now,
      });
      log.info(`Marketing consent recorded (resubscribe) via ${record.source}`);
      return true;
    }

    const created = await createDocumentIfNotExists('subscribers', id, {
      ...consentFields,
      email,
      name: record.name || '',
      status: 'active',
      source: record.source,
      confirmedAt: now,
      subscribedAt: now,
      emailsSent: 0,
      emailsOpened: 0,
      lastEmailSentAt: null,
    });

    if (!created.success && !created.exists) return false;
    log.info(`Marketing consent recorded via ${record.source}`);
    return true;
  } catch (error: unknown) {
    // Never surface this to the caller's user — they registered / ordered fine.
    log.error('Failed to record marketing consent:', error);
    return false;
  }
}
