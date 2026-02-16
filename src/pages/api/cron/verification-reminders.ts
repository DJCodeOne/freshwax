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
import { fetchWithTimeout } from '../../../lib/api-utils';

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

  const isAuthorized =
    (cronSecret && authHeader === `Bearer ${cronSecret}`) ||
    (adminKey && xAdminKey === adminKey);

  if (!isAuthorized) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    return new Response(JSON.stringify({ success: true, skipped: true, reason: 'Email not configured' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    console.log('[VerifyReminders] Starting verification reminder run');

    // Query unverified users
    const unverifiedUsers = await queryCollection('users', {
      filters: [{ field: 'emailVerified', op: 'EQUAL', value: false }],
      limit: 200,
      skipCache: true
    });

    console.log(`[VerifyReminders] Found ${unverifiedUsers.length} unverified users`);

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
          console.error(`[VerifyReminders] Failed to send to ${email}:`, await resendResponse.text());
          skipped++;
        }
      } catch (emailErr) {
        console.error(`[VerifyReminders] Error sending to ${email}:`, emailErr);
        skipped++;
      }
    }

    console.log(`[VerifyReminders] Done. Sent: ${sent}, Skipped: ${skipped}`);

    return new Response(JSON.stringify({
      success: true,
      sent,
      skipped,
      totalUnverified: unverifiedUsers.length
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    console.error('[VerifyReminders] Error:', error instanceof Error ? error.message : String(error));
    return new Response(JSON.stringify({ success: false, error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// GET forwards to POST for manual triggering
export const GET: APIRoute = async (context) => POST(context);

function buildReminderEmail(name: string): string {
  const greeting = name ? `Hi ${name},` : 'Hi there,';
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #141414; border-radius: 12px; border: 1px solid #262626;">
          <tr>
            <td style="padding: 40px 40px 20px; text-align: center; border-bottom: 1px solid #262626;">
              <img src="${SITE_URL}/logo.webp" alt="Fresh Wax" width="120" style="display: block; margin: 0 auto 20px;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 700;">Verify Your Email</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 40px;">
              <p style="color: #a3a3a3; font-size: 16px; line-height: 1.6; margin: 0 0 20px;">
                ${greeting}
              </p>
              <p style="color: #a3a3a3; font-size: 16px; line-height: 1.6; margin: 0 0 20px;">
                Just a friendly reminder to verify your email address on Fresh Wax. Verifying unlocks all features including purchasing, commenting, and live chat.
              </p>
              <p style="color: #a3a3a3; font-size: 16px; line-height: 1.6; margin: 0 0 30px;">
                Click below to log in and verify your email:
              </p>
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <a href="${SITE_URL}/verify-email" style="display: inline-block; background-color: #dc2626; color: #ffffff; text-decoration: none; padding: 16px 40px; border-radius: 8px; font-weight: 600; font-size: 16px;">
                      Verify My Email
                    </a>
                  </td>
                </tr>
              </table>
              <p style="color: #666666; font-size: 14px; line-height: 1.6; margin: 30px 0 0; text-align: center;">
                If you didn't create an account on Fresh Wax, you can safely ignore this email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 40px; background-color: #1a1a1a; border-top: 1px solid #262626; border-radius: 0 0 12px 12px;">
              <p style="color: #666666; font-size: 12px; margin: 0; text-align: center;">
                Fresh Wax - Jungle &amp; Drum and Bass<br>
                <a href="${SITE_URL}" style="color: #888888;">freshwax.co.uk</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
