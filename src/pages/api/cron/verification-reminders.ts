// src/pages/api/cron/verification-reminders.ts
// Cron: 0 10 * * * (daily at 10:00 UTC)
// Dashboard: Cloudflare Pages > Settings > Cron Triggers
//
// Scheduled job to send email verification reminders to unverified users.
// Queries users with emailVerified == false, created > 24h ago and < 30 days ago.
// Skips users reminded within the last 7 days. Max 50 emails per run.

import type { APIRoute } from 'astro';
import { queryCollection, updateDocument } from '../../../lib/firebase-rest';
import { SITE_URL } from '../../../lib/constants';
import { fetchWithTimeout, ApiErrors, createLogger, timingSafeCompare, successResponse } from '../../../lib/api-utils';
const log = createLogger('[verification-reminders]');
import { emailWrapper, ctaButton } from '../../../lib/email-wrapper';

export const prerender = false;

const MAX_EMAILS_PER_RUN = 50;
const REMINDER_COOLDOWN_DAYS = 7;
const MIN_ACCOUNT_AGE_HOURS = 24;
const MAX_ACCOUNT_AGE_DAYS = 30;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;

  // Verify authorization
  const authHeader = request.headers.get('Authorization');
  const cronSecret = env?.CRON_SECRET || import.meta.env.CRON_SECRET;
  const adminKey = env?.ADMIN_KEY || import.meta.env.ADMIN_KEY;
  const xAdminKey = request.headers.get('X-Admin-Key');

  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const isAuthorized =
    (cronSecret && token && timingSafeCompare(token, cronSecret)) ||
    (adminKey && xAdminKey && timingSafeCompare(xAdminKey, adminKey));

  if (!isAuthorized) {
    return ApiErrors.unauthorized('Unauthorized');
  }

  const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    return successResponse({ skipped: true, reason: 'Email not configured' });
  }

  try {
    log.info('[VerifyReminders] Starting verification reminder run');

    // Query unverified users
    const unverifiedUsers = await queryCollection('users', {
      filters: [{ field: 'emailVerified', op: 'EQUAL', value: false }],
      limit: 200,
      skipCache: true
    });

    log.info(`[VerifyReminders] Found ${unverifiedUsers.length} unverified users`);

    const now = Date.now();
    const minAge = MIN_ACCOUNT_AGE_HOURS * 60 * 60 * 1000;
    const maxAge = MAX_ACCOUNT_AGE_DAYS * 24 * 60 * 60 * 1000;
    const cooldown = REMINDER_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

    let sent = 0;
    let skipped = 0;

    for (const user of unverifiedUsers) {
      if (sent >= MAX_EMAILS_PER_RUN) break;

      const email = user.email;
      if (!email) { skipped++; continue; }

      // Check account age
      const createdAt = user.createdAt ? new Date(user.createdAt).getTime() : 0;
      if (!createdAt) { skipped++; continue; }

      const accountAge = now - createdAt;
      if (accountAge < minAge || accountAge > maxAge) { skipped++; continue; }

      // Check reminder cooldown
      if (user.lastVerificationReminder) {
        const lastReminder = new Date(user.lastVerificationReminder).getTime();
        if (now - lastReminder < cooldown) { skipped++; continue; }
      }

      // Send reminder email
      try {
        const emailHtml = buildReminderEmail(user.displayName || user.firstName || '');

        const resendResponse = await fetchWithTimeout('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Fresh Wax <noreply@freshwax.co.uk>',
            to: email,
            subject: 'Reminder: Verify Your Email - Fresh Wax',
            html: emailHtml
          })
        }, 10000);

        if (resendResponse.ok) {
          // Update user doc with reminder timestamp
          const userId = user.id || user.uid;
          if (userId) {
            await updateDocument('users', userId, {
              lastVerificationReminder: new Date().toISOString()
            });
          }
          sent++;
        } else {
          log.error(`[VerifyReminders] Failed to send to ${email}:`, await resendResponse.text());
          skipped++;
        }
      } catch (emailErr: unknown) {
        log.error(`[VerifyReminders] Error sending to ${email}:`, emailErr);
        skipped++;
      }
    }

    log.info(`[VerifyReminders] Done. Sent: ${sent}, Skipped: ${skipped}`);

    return successResponse({ sent,
      skipped,
      totalUnverified: unverifiedUsers.length });

  } catch (error: unknown) {
    log.error('[VerifyReminders] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
};

// GET forwards to POST for manual triggering
export const GET: APIRoute = async (context) => POST(context);

function buildReminderEmail(name: string): string {
  const greeting = name ? `Hi ${name},` : 'Hi there,';
  const content = `
    <div style="text-align: center; margin-bottom: 24px;">
      <img src="${SITE_URL}/logo.webp" alt="Fresh Wax" width="120" style="display: inline-block; margin: 0 auto 20px;">
    </div>
    <p style="color: #a3a3a3; font-size: 16px; line-height: 1.6; margin: 0 0 20px;" class="text-secondary">
      ${greeting}
    </p>
    <p style="color: #a3a3a3; font-size: 16px; line-height: 1.6; margin: 0 0 20px;" class="text-secondary">
      Just a friendly reminder to verify your email address on Fresh Wax. Verifying unlocks all features including purchasing, commenting, and live chat.
    </p>
    <p style="color: #a3a3a3; font-size: 16px; line-height: 1.6; margin: 0 0 30px;" class="text-secondary">
      Click below to log in and verify your email:
    </p>
    ${ctaButton('Verify My Email', `${SITE_URL}/verify-email`)}
    <p style="color: #666666; font-size: 14px; line-height: 1.6; margin: 30px 0 0; text-align: center;" class="text-muted">
      If you didn't create an account on Fresh Wax, you can safely ignore this email.
    </p>`;

  return emailWrapper(content, {
    title: 'Verify Your Email',
    headerText: 'Verify Your Email',
  });
}
