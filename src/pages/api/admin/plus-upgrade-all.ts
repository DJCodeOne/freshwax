// src/pages/api/admin/plus-upgrade-all.ts
// Upgrade all registered users to Plus and send thank you emails
// Usage: POST { adminKey, testEmail?, execute? }

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { saQueryCollection, saUpdateDocument } from '../../../lib/firebase-service-account';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { SITE_URL } from '../../../lib/constants';
import { fetchWithTimeout, ApiErrors } from '../../../lib/api-utils';
import { emailWrapper, ctaButton, esc } from '../../../lib/email-wrapper';

export const prerender = false;

function getServiceAccountKey(env: any): string | null {
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) return null;

  return JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'auto',
    private_key: privateKey.replace(/\\n/g, '\n'),
    client_email: clientEmail,
    client_id: '',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token'
  });
}

function buildThankYouEmail(userName: string): string {
  const displayName = esc(userName) || 'there';

  const content = `
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;" class="text-primary">
                Hey ${displayName},
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 24px; line-height: 1.7;" class="text-secondary">
                Thank you for being one of the first to register on Fresh Wax! As a thank you for your early support, I've upgraded your account to <strong style="color: #dc2626;">Plus membership</strong> -- completely free.
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 24px; line-height: 1.7;" class="text-secondary">
                Your support means everything to me as I build this platform for the jungle and drum &amp; bass community.
              </p>

              <!-- Benefits Box -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #1f1f1f; border-radius: 8px; margin-bottom: 28px; border-left: 4px solid #dc2626;" class="detail-box">
                <tr>
                  <td style="padding: 24px;">
                    <h3 style="color: #ffffff; margin: 0 0 16px; font-size: 16px; text-transform: uppercase; letter-spacing: 1px;" class="text-primary">Your Plus Benefits</h3>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      <tr><td style="padding: 8px 0; color: #a3a3a3; font-size: 14px;" class="text-secondary"><span style="color: #22c55e; margin-right: 8px;">&#10003;</span> 5 mix uploads per week (vs 2)</td></tr>
                      <tr><td style="padding: 8px 0; color: #a3a3a3; font-size: 14px;" class="text-secondary"><span style="color: #22c55e; margin-right: 8px;">&#10003;</span> Book DJ slots 30 days in advance</td></tr>
                      <tr><td style="padding: 8px 0; color: #a3a3a3; font-size: 14px;" class="text-secondary"><span style="color: #22c55e; margin-right: 8px;">&#10003;</span> Extended playlist (1000 tracks)</td></tr>
                      <tr><td style="padding: 8px 0; color: #a3a3a3; font-size: 14px;" class="text-secondary"><span style="color: #22c55e; margin-right: 8px;">&#10003;</span> 3 track skips per day in chat</td></tr>
                      <tr><td style="padding: 8px 0; color: #a3a3a3; font-size: 14px;" class="text-secondary"><span style="color: #22c55e; margin-right: 8px;">&#10003;</span> Request extended streaming events</td></tr>
                      <tr><td style="padding: 8px 0; color: #a3a3a3; font-size: 14px;" class="text-secondary"><span style="color: #22c55e; margin-right: 8px;">&#10003;</span> Custom chat avatar icon</td></tr>
                      <tr><td style="padding: 8px 0; color: #a3a3a3; font-size: 14px;" class="text-secondary"><span style="color: #22c55e; margin-right: 8px;">&#10003;</span> Automatic access to new features</td></tr>
                      <tr><td style="padding: 8px 0; color: #a3a3a3; font-size: 14px;" class="text-secondary"><span style="color: #22c55e; margin-right: 8px;">&#10003;</span> 50% off invite-a-friend (one-time offer)</td></tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="color: #737373; font-size: 14px; margin: 0 0 28px; line-height: 1.6;" class="text-muted">
                Your Plus membership is valid for <strong style="color: #ffffff;" class="text-primary">one year</strong> from today. Keep supporting underground music!
              </p>

              ${ctaButton('Visit Your Dashboard', SITE_URL + '/account/dashboard')}

              <p style="color: #737373; font-size: 13px; margin: 0; text-align: center;" class="text-muted">
                Big love, Code One
              </p>`;

  return emailWrapper(content, {
    title: "You're Now a Plus Member!",
    headerText: "You're Now a Plus Member!",
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`plus-upgrade-all:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  try {
    const env = locals.runtime.env;
    const body = await request.json();

    // Admin auth
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const { testEmail, testName, execute } = body;
    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (!RESEND_API_KEY) {
      return ApiErrors.serverError('Resend API key not configured');
    }

    // Test mode: send email to testEmail only
    if (testEmail) {
      const emailHtml = buildThankYouEmail(testName || 'Early Supporter');

      const response = await fetchWithTimeout('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Fresh Wax <noreply@freshwax.co.uk>',
          to: [testEmail],
          subject: '🎉 You\'re Now a Fresh Wax Plus Member!',
          html: emailHtml
        })
      }, 10000);

      if (response.ok) {
        const result = await response.json();
        return new Response(JSON.stringify({
          success: true,
          message: `Test email sent to ${testEmail}`,
          emailId: result.id
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } else {
        const error = await response.text();
        return ApiErrors.serverError('Failed to send test email: ${error}');
      }
    }

    // Get all users
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const serviceAccountKey = getServiceAccountKey(env);

    if (!serviceAccountKey) {
      return ApiErrors.serverError('Service account not configured');
    }

    // Fetch all users
    const users = await saQueryCollection(serviceAccountKey, projectId, 'users', {
      limit: 500
    });

    // Filter to non-Plus users with email
    const usersToUpgrade = users.filter((user: any) => {
      const hasEmail = user.email && user.email.includes('@');
      const isAlreadyPlus = user.subscription?.tier === 'pro';
      return hasEmail && !isAlreadyPlus;
    });

    // Also get users who are Plus but might want the thank you email
    const allUsersWithEmail = users.filter((user: any) => user.email && user.email.includes('@'));

    if (!execute) {
      // Preview mode - show what would happen
      return new Response(JSON.stringify({
        message: 'Preview mode - add execute: true to perform upgrade',
        totalUsers: users.length,
        usersWithEmail: allUsersWithEmail.length,
        usersToUpgrade: usersToUpgrade.length,
        alreadyPlus: allUsersWithEmail.length - usersToUpgrade.length,
        userList: allUsersWithEmail.map((u: any) => ({
          email: u.email,
          name: u.displayName || u.name,
          currentTier: u.subscription?.tier || 'free',
          willUpgrade: !u.subscription?.tier || u.subscription?.tier !== 'pro'
        }))
      }, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Execute mode - upgrade users and send emails
    const now = new Date().toISOString();
    const oneYearFromNow = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

    const results = {
      upgraded: [] as string[],
      emailsSent: [] as string[],
      emailsFailed: [] as string[],
      errors: [] as string[]
    };

    for (const user of allUsersWithEmail) {
      const userId = user.id;
      const userEmail = user.email;
      const userName = user.displayName || user.name || 'there';

      // Upgrade to Plus if not already
      if (!user.subscription?.tier || user.subscription.tier !== 'pro') {
        try {
          await saUpdateDocument(serviceAccountKey, projectId, 'users', userId, {
            subscription: {
              tier: 'pro',
              subscribedAt: now,
              startedAt: now,
              expiresAt: oneYearFromNow,
              source: 'early_supporter_gift',
              grantedBy: 'admin'
            }
          });
          results.upgraded.push(userEmail);
        } catch (err) {
          results.errors.push(`Failed to upgrade ${userEmail}: ${err}`);
        }
      }

      // Send thank you email
      try {
        const emailHtml = buildThankYouEmail(userName);

        const response = await fetchWithTimeout('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Fresh Wax <noreply@freshwax.co.uk>',
            to: [userEmail],
            subject: '🎉 You\'re Now a Fresh Wax Plus Member!',
            html: emailHtml
          })
        }, 10000);

        if (response.ok) {
          results.emailsSent.push(userEmail);
        } else {
          results.emailsFailed.push(userEmail);
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (err) {
        results.emailsFailed.push(userEmail);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Upgraded ${results.upgraded.length} users, sent ${results.emailsSent.length} emails`,
      results
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[plus-upgrade-all] Error:', error);
    return ApiErrors.serverError('Unknown error');
  }
};
