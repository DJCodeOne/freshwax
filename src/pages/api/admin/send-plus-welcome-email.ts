// src/pages/api/admin/send-plus-welcome-email.ts
// Sends welcome/confirmation email when user subscribes to Plus

import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const { email, name, subscribedAt, expiresAt, plusId, isRenewal } = body;

    if (!email) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Email address required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Get Resend API key
    const runtime = (locals as any)?.runtime?.env || {};
    const RESEND_API_KEY = runtime.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (!RESEND_API_KEY) {
      console.log('[send-plus-welcome-email] No Resend API key configured');
      return new Response(JSON.stringify({
        success: false,
        message: 'Email service not configured'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Format dates
    const subDate = subscribedAt ? new Date(subscribedAt) : new Date();
    const expDate = expiresAt ? new Date(expiresAt) : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

    const formatDate = (date: Date) => date.toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });

    const formatTime = (date: Date) => date.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit'
    });

    const subscribedDateStr = formatDate(subDate);
    const subscribedTimeStr = formatTime(subDate);
    const expiresDateStr = formatDate(expDate);

    // Calculate days until expiry
    const daysUntilExpiry = Math.ceil((expDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

    const loginUrl = 'https://freshwax.co.uk/account/dashboard';

    // Subject line based on renewal or new subscription
    const subject = isRenewal
      ? `Your Fresh Wax Plus subscription has been renewed! 👑`
      : `Welcome to Fresh Wax Plus! Your subscription is active 👑`;

    const headerText = isRenewal ? 'Subscription Renewed!' : 'Welcome to Plus!';
    const introText = isRenewal
      ? `Great news! Your Plus subscription has been successfully renewed.`
      : `Thanks for upgrading to Plus! Your subscription is now active and you have access to all Plus features.`;

    // Build email HTML
    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fresh Wax Plus</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #141414; border-radius: 12px; overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 40px 40px 30px; text-align: center;">
              <div style="font-size: 48px; margin-bottom: 10px;">👑</div>
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700;">
                ${headerText}
              </h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;">
                Hey ${name || 'there'},
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 30px; line-height: 1.6;">
                ${introText}
              </p>

              <!-- Subscription Details Card -->
              <div style="background: linear-gradient(180deg, #1f2937 0%, #111827 100%); border: 1px solid #374151; border-radius: 12px; padding: 24px; margin-bottom: 30px;">
                <h3 style="color: #f59e0b; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 20px;">
                  Subscription Details
                </h3>

                <table width="100%" style="border-collapse: collapse;">
                  ${plusId ? `
                  <tr>
                    <td style="color: #9ca3af; font-size: 14px; padding: 8px 0; border-bottom: 1px solid #374151;">Plus ID</td>
                    <td style="color: #ffffff; font-size: 14px; padding: 8px 0; border-bottom: 1px solid #374151; text-align: right; font-family: monospace;">${plusId}</td>
                  </tr>
                  ` : ''}
                  <tr>
                    <td style="color: #9ca3af; font-size: 14px; padding: 8px 0; border-bottom: 1px solid #374151;">Registered</td>
                    <td style="color: #ffffff; font-size: 14px; padding: 8px 0; border-bottom: 1px solid #374151; text-align: right;">${subscribedDateStr} at ${subscribedTimeStr}</td>
                  </tr>
                  <tr>
                    <td style="color: #9ca3af; font-size: 14px; padding: 8px 0; border-bottom: 1px solid #374151;">Valid Until</td>
                    <td style="color: #22c55e; font-size: 14px; padding: 8px 0; border-bottom: 1px solid #374151; text-align: right; font-weight: 600;">${expiresDateStr}</td>
                  </tr>
                  <tr>
                    <td style="color: #9ca3af; font-size: 14px; padding: 8px 0;">Subscription</td>
                    <td style="color: #f59e0b; font-size: 14px; padding: 8px 0; text-align: right; font-weight: 600;">Plus Annual (£10/year)</td>
                  </tr>
                </table>
              </div>

              <!-- Benefits -->
              <p style="color: #ffffff; font-size: 16px; margin: 0 0 15px; font-weight: 600;">
                Your Plus Benefits:
              </p>

              <ul style="color: #a3a3a3; font-size: 15px; margin: 0 0 30px; padding-left: 0; list-style: none; line-height: 2;">
                <li style="padding-left: 24px; position: relative;">
                  <span style="position: absolute; left: 0; color: #f59e0b;">✓</span>
                  5 DJ mix uploads per week (vs 2 standard)
                </li>
                <li style="padding-left: 24px; position: relative;">
                  <span style="position: absolute; left: 0; color: #f59e0b;">✓</span>
                  Long duration events up to 24 hours
                </li>
                <li style="padding-left: 24px; position: relative;">
                  <span style="position: absolute; left: 0; color: #f59e0b;">✓</span>
                  Book multiple slots for day-long events
                </li>
                <li style="padding-left: 24px; position: relative;">
                  <span style="position: absolute; left: 0; color: #f59e0b;">✓</span>
                  Record live stream button enabled
                </li>
                <li style="padding-left: 24px; position: relative;">
                  <span style="position: absolute; left: 0; color: #f59e0b;">✓</span>
                  Gold crown on your chat avatar
                </li>
                <li style="padding-left: 24px; position: relative;">
                  <span style="position: absolute; left: 0; color: #f59e0b;">✓</span>
                  Priority in DJ Lobby queue
                </li>
              </ul>

              <!-- Renewal Notice -->
              <div style="background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 8px; padding: 16px; margin-bottom: 30px;">
                <p style="color: #f59e0b; font-size: 14px; margin: 0; line-height: 1.5;">
                  <strong>About Renewals:</strong> Your Plus benefits will remain active for ${daysUntilExpiry} days.
                  If not renewed, your account will revert to Standard limits (no data is lost).
                  Simply renew anytime to reactivate Plus features!
                </p>
              </div>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 10px 0 30px;">
                    <a href="${loginUrl}" style="display: inline-block; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: #000000; text-decoration: none; padding: 16px 40px; border-radius: 8px; font-weight: 700; font-size: 16px;">
                      Go to Dashboard →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="color: #6b7280; font-size: 14px; margin: 0; line-height: 1.6; text-align: center;">
                Questions? Just reply to this email or reach out anytime.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #0a0a0a; padding: 25px 40px; border-top: 1px solid #262626;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <p style="font-size: 13px; margin: 0;">
                      <span style="color: #ffffff;">Fresh</span><span style="color: #dc2626;">Wax</span>
                      <span style="color: #f59e0b; margin-left: 8px;">Plus</span>
                    </p>
                  </td>
                  <td align="right">
                    <a href="https://freshwax.co.uk" style="text-decoration: none; font-size: 13px; color: #ffffff;">freshwax.co.uk</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();

    // Send via Resend
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Fresh Wax <noreply@freshwax.co.uk>',
        to: email,
        subject: subject,
        html: emailHtml
      })
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('[send-plus-welcome-email] Resend error:', result);
      return new Response(JSON.stringify({
        success: false,
        error: result.message || 'Failed to send email'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    console.log('[send-plus-welcome-email] Email sent successfully to:', email);

    return new Response(JSON.stringify({
      success: true,
      messageId: result.id
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[send-plus-welcome-email] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
