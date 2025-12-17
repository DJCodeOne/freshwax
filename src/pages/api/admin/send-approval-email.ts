// src/pages/api/admin/send-approval-email.ts
// Sends approval confirmation email to artists/partners

import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const { email, name, type } = await request.json();

    if (!email) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Email address required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Get Resend API key from runtime env or import.meta.env
    const runtime = (locals as any)?.runtime?.env || {};
    const RESEND_API_KEY = runtime.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (!RESEND_API_KEY) {
      console.log('[send-approval-email] No Resend API key configured');
      return new Response(JSON.stringify({
        success: false,
        message: 'Email service not configured'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const loginUrl = 'https://freshwax.co.uk/login?redirect=/account/dashboard';

    // Determine role labels and content based on type
    const isArtist = type === 'artist' || type === 'both';
    const isMerch = type === 'merch' || type === 'both';

    // Build the approval message
    let approvalText = '';
    if (type === 'both') {
      approvalText = 'Your <strong style="color: #22c55e;">Artist</strong> and <strong style="color: #22c55e;">Merch</strong> application has been approved.';
    } else if (type === 'artist') {
      approvalText = 'Your <strong style="color: #22c55e;">Artist</strong> application has been approved.';
    } else {
      approvalText = 'Your <strong style="color: #22c55e;">Partner</strong> application has been approved.';
    }

    // Build the subject line
    let subjectRole = '';
    if (type === 'both') {
      subjectRole = 'Artist & Merch Partner';
    } else if (type === 'artist') {
      subjectRole = 'Artist';
    } else {
      subjectRole = 'Partner';
    }

    // Build features list based on approved roles
    let featuresList = '';
    if (isArtist) {
      featuresList += `
                <li>Upload and manage your releases</li>
                <li>Track your sales and royalties</li>
                <li>View your streaming statistics</li>`;
    }
    if (isMerch) {
      featuresList += `
                <li>Send your merchandise for automatic listing</li>
                <li>Monitor your inventory</li>
                <li>Track orders and sales</li>`;
    }
    if (isArtist || isMerch) {
      featuresList += `
                <li>View your earnings</li>`;
    }

    // Build email HTML
    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to the Fresh Wax community.</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #141414; border-radius: 12px; overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%); padding: 40px 40px 30px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700;">
                🎉 You're Approved!
              </h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;">
                Hey ${name || 'there'},
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 25px; line-height: 1.6;">
                Great news! ${approvalText} Welcome to the Fresh Wax community.
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 30px; line-height: 1.6;">
                You now have access to the Pro Dashboard where you can:
              </p>

              <ul style="color: #a3a3a3; font-size: 15px; margin: 0 0 30px; padding-left: 20px; line-height: 1.8;">${featuresList}
              </ul>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 10px 0 30px;">
                    <a href="${loginUrl}" style="display: inline-block; background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%); color: #ffffff; text-decoration: none; padding: 16px 40px; border-radius: 8px; font-weight: 600; font-size: 16px;">
                      Log In →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="color: #a3a3a3; font-size: 14px; margin: 0; line-height: 1.6;">
                If you have any questions, just reply to this email or reach out to us anytime.
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
                      <span style="color: #ffffff;">Fresh</span><span style="color: #dc2626;">Wax</span><span style="color: #ffffff;"> - Underground Music Platform</span>
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
        subject: `Welcome to Fresh Wax! Your ${subjectRole} account is approved 🎉`,
        html: emailHtml
      })
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('[send-approval-email] Resend error:', result);
      return new Response(JSON.stringify({
        success: false,
        error: result.message || 'Failed to send email'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    console.log('[send-approval-email] Email sent successfully to:', email);

    return new Response(JSON.stringify({
      success: true,
      messageId: result.id
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[send-approval-email] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
