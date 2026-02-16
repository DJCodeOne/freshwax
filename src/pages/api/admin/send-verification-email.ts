// src/pages/api/admin/send-verification-email.ts
// Admin endpoint to send email verification link to a user

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { parseJsonBody, fetchWithTimeout, ApiErrors } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { SITE_URL } from '../../../lib/constants';
import { emailWrapper, ctaButton } from '../../../lib/email-wrapper';

const sendVerificationEmailSchema = z.object({
  email: z.string().email(),
}).passthrough();

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`send-verification-email:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals.runtime.env || {};

  // SECURITY: Require admin authentication
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });

  try {
    const body = await parseJsonBody(request);

    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const parsed = sendVerificationEmailSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { email } = parsed.data;

    // Get Firebase Admin credentials
    const FIREBASE_PROJECT_ID = env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const FIREBASE_API_KEY = env.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;
    const RESEND_API_KEY = env.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (!RESEND_API_KEY) {
      return ApiErrors.serverError('Email service not configured');
    }

    // First, look up the user by email using Firebase REST API
    const lookupResponse = await fetchWithTimeout(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: [email]
        })
      },
      10000
    );

    // Try to get user by sending password reset (which tells us if user exists)
    // Actually, let's use the sendOobCode endpoint to send verification email
    const sendVerificationResponse = await fetchWithTimeout(
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
      },
      10000
    );

    // Since we can't use Firebase's built-in email verification without user being signed in,
    // we'll send a custom email asking them to log in and verify
    const verifyContent = `
      <div style="text-align: center; margin-bottom: 24px;">
        <img src="${SITE_URL}/logo.webp" alt="Fresh Wax" width="120" style="display: inline-block; margin: 0 auto 20px;">
      </div>
      <p style="color: #a3a3a3; font-size: 16px; line-height: 1.6; margin: 0 0 20px;" class="text-secondary">
        Hi there,
      </p>
      <p style="color: #a3a3a3; font-size: 16px; line-height: 1.6; margin: 0 0 20px;" class="text-secondary">
        Please verify your email address to unlock all features on Fresh Wax, including purchasing, commenting, and chatting.
      </p>
      <p style="color: #a3a3a3; font-size: 16px; line-height: 1.6; margin: 0 0 30px;" class="text-secondary">
        Click the button below to log in and verify your email:
      </p>
      ${ctaButton('Verify My Email', `${SITE_URL}/verify-email`)}
      <p style="color: #666666; font-size: 14px; line-height: 1.6; margin: 30px 0 0; text-align: center;" class="text-muted">
        If you didn't create an account on Fresh Wax, you can safely ignore this email.
      </p>`;

    const emailHtml = emailWrapper(verifyContent, {
      title: 'Verify Your Email',
      headerText: 'Verify Your Email',
    });

    // Send via Resend
    const resendResponse = await fetchWithTimeout('https://api.resend.com/emails', {
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
    }, 10000);

    const resendResult = await resendResponse.json();

    if (!resendResponse.ok) {
      console.error('[SendVerification] Resend error:', resendResult);
      return ApiErrors.serverError('Failed to send email');
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

  } catch (error: unknown) {
    console.error('[SendVerification] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to send verification email');
  }
};
