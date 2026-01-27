// src/pages/api/admin/plus-upgrade-all.ts
// Upgrade all registered users to Plus and send thank you emails
// Usage: POST { adminKey, testEmail?, execute? }

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { saQueryCollection, saUpdateDocument } from '../../../lib/firebase-service-account';

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
  const displayName = userName || 'there';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #111; border-radius: 12px; overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%); padding: 40px; text-align: center;">
              <div style="font-size: 48px; margin-bottom: 12px;">🎉</div>
              <h1 style="margin: 0; color: #fff; font-size: 28px; font-weight: 700;">You're Now a Plus Member!</h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <p style="color: #fff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;">
                Hey ${displayName},
              </p>

              <p style="color: #ccc; font-size: 16px; margin: 0 0 24px; line-height: 1.7;">
                Thank you for being one of the first to register on Fresh Wax! As a thank you for your early support, I've upgraded your account to <strong style="color: #dc2626;">Plus membership</strong> — completely free.
              </p>

              <p style="color: #ccc; font-size: 16px; margin: 0 0 24px; line-height: 1.7;">
                Your support means everything to me as I build this platform for the jungle and drum & bass community.
              </p>

              <!-- Benefits Box -->
              <div style="background: #1a1a1a; border-radius: 8px; padding: 24px; margin-bottom: 28px; border-left: 4px solid #dc2626;">
                <h3 style="color: #fff; margin: 0 0 16px; font-size: 16px; text-transform: uppercase; letter-spacing: 1px;">Your Plus Benefits</h3>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding: 8px 0; color: #ccc; font-size: 14px;">
                      <span style="color: #22c55e; margin-right: 8px;">✓</span> 5 mix uploads per week (vs 2)
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #ccc; font-size: 14px;">
                      <span style="color: #22c55e; margin-right: 8px;">✓</span> Book DJ slots 30 days in advance
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #ccc; font-size: 14px;">
                      <span style="color: #22c55e; margin-right: 8px;">✓</span> Extended playlist (1000 tracks)
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #ccc; font-size: 14px;">
                      <span style="color: #22c55e; margin-right: 8px;">✓</span> 3 track skips per day in chat
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #ccc; font-size: 14px;">
                      <span style="color: #22c55e; margin-right: 8px;">✓</span> Request extended streaming events
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #ccc; font-size: 14px;">
                      <span style="color: #22c55e; margin-right: 8px;">✓</span> Custom chat avatar icon
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #ccc; font-size: 14px;">
                      <span style="color: #22c55e; margin-right: 8px;">✓</span> Automatic access to new features
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #ccc; font-size: 14px;">
                      <span style="color: #22c55e; margin-right: 8px;">✓</span> 50% off invite-a-friend (one-time offer)
                    </td>
                  </tr>
                </table>
              </div>

              <p style="color: #888; font-size: 14px; margin: 0 0 28px; line-height: 1.6;">
                Your Plus membership is valid for <strong style="color: #fff;">one year</strong> from today. Keep supporting underground music!
              </p>

              <!-- CTA -->
              <div style="text-align: center; margin-top: 32px;">
                <a href="https://freshwax.co.uk/account/dashboard" style="display: inline-block; background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%); color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px;">
                  Visit Your Dashboard
                </a>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 24px 40px; background: #0a0a0a; text-align: center; border-top: 1px solid #222;">
              <p style="color: #666; font-size: 13px; margin: 0 0 8px;">
                Big love, Code One 🙏
              </p>
              <p style="color: #444; font-size: 12px; margin: 0;">
                <a href="https://freshwax.co.uk" style="color: #dc2626; text-decoration: none;">freshwax.co.uk</a>
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

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any)?.runtime?.env;
    const body = await request.json();

    // Admin auth
    const authError = requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const { testEmail, testName, execute } = body;
    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (!RESEND_API_KEY) {
      return new Response(JSON.stringify({ error: 'Resend API key not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Test mode: send email to testEmail only
    if (testEmail) {
      const emailHtml = buildThankYouEmail(testName || 'Early Supporter');

      const response = await fetch('https://api.resend.com/emails', {
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
      });

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
        return new Response(JSON.stringify({ error: `Failed to send test email: ${error}` }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Get all users
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const serviceAccountKey = getServiceAccountKey(env);

    if (!serviceAccountKey) {
      return new Response(JSON.stringify({ error: 'Service account not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
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

        const response = await fetch('https://api.resend.com/emails', {
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
        });

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
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
