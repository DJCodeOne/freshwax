// src/pages/api/admin/send-verification-email.ts
// Admin endpoint to send email verification link to a user

import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env || {};

  try {
    const body = await request.json();
    const { email } = body;

    if (!email) {
      return new Response(JSON.stringify({ error: 'Email required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get Firebase Admin credentials
    const FIREBASE_PROJECT_ID = env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const FIREBASE_API_KEY = env.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;
    const RESEND_API_KEY = env.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (!RESEND_API_KEY) {
      return new Response(JSON.stringify({ error: 'Email service not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // First, look up the user by email using Firebase REST API
    const lookupResponse = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: [email]
        })
      }
    );

    // Try to get user by sending password reset (which tells us if user exists)
    // Actually, let's use the sendOobCode endpoint to send verification email
    const sendVerificationResponse = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestType: 'VERIFY_EMAIL',
          email: email,
          // This requires the user to be signed in, which we can't do server-side
          // So we'll generate a custom email instead
        })
      }
    );

    // Since we can't use Firebase's built-in email verification without user being signed in,
    // we'll send a custom email asking them to log in and verify
    const emailHtml = `
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
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #141414; border-radius: 12px; border: 1px solid #262626;">
          <!-- Header -->
          <tr>
            <td style="padding: 40px 40px 20px; text-align: center; border-bottom: 1px solid #262626;">
              <img src="https://freshwax.co.uk/logo.webp" alt="Fresh Wax" width="120" style="display: block; margin: 0 auto 20px;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 700;">Verify Your Email</h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <p style="color: #a3a3a3; font-size: 16px; line-height: 1.6; margin: 0 0 20px;">
                Hi there,
              </p>
              <p style="color: #a3a3a3; font-size: 16px; line-height: 1.6; margin: 0 0 20px;">
                Please verify your email address to unlock all features on Fresh Wax, including purchasing, commenting, and chatting.
              </p>
              <p style="color: #a3a3a3; font-size: 16px; line-height: 1.6; margin: 0 0 30px;">
                Click the button below to log in and verify your email:
              </p>

              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <a href="https://freshwax.co.uk/verify-email" style="display: inline-block; background-color: #dc2626; color: #ffffff; text-decoration: none; padding: 16px 40px; border-radius: 8px; font-weight: 600; font-size: 16px;">
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

          <!-- Footer -->
          <tr>
            <td style="padding: 20px 40px; background-color: #1a1a1a; border-top: 1px solid #262626; border-radius: 0 0 12px 12px;">
              <p style="color: #666666; font-size: 12px; margin: 0; text-align: center;">
                Fresh Wax - Jungle & Drum and Bass<br>
                <a href="https://freshwax.co.uk" style="color: #888888;">freshwax.co.uk</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `;

    // Send via Resend
    const resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Fresh Wax <noreply@freshwax.co.uk>',
        to: email,
        subject: 'Verify Your Email - Fresh Wax',
        html: emailHtml
      })
    });

    const resendResult = await resendResponse.json();

    if (!resendResponse.ok) {
      console.error('[SendVerification] Resend error:', resendResult);
      return new Response(JSON.stringify({
        error: 'Failed to send email',
        details: resendResult
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log('[SendVerification] Email sent to:', email, 'ID:', resendResult.id);

    return new Response(JSON.stringify({
      success: true,
      message: `Verification email sent to ${email}`,
      emailId: resendResult.id
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[SendVerification] Error:', error);
    return new Response(JSON.stringify({
      error: error.message || 'Failed to send verification email'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
