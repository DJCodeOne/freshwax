// src/pages/api/newsletter/subscribe.ts
// Newsletter subscription with GDPR-compliant double opt-in
// 1. Validates consent checkbox
// 2. Creates subscriber as 'pending_confirmation'
// 3. Sends confirmation email via Resend
// 4. User must click link to activate (handled by confirm.ts)

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, createDocumentIfNotExists, updateDocument } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { SITE_URL } from '../../../lib/constants';
import { fetchWithTimeout } from '../../../lib/api-utils';

const SubscribeSchema = z.object({
  email: z.string().email('Invalid email format').max(320),
  source: z.string().max(50).optional().default('footer'),
  consent: z.literal(true, { message: 'You must agree to receive marketing emails' }),
  name: z.string().max(100).optional(),
});

function emailToDocId(email: string): string {
  return email.toLowerCase().trim().replace(/[.@]/g, '_');
}

export const prerender = false;

/** Generate a URL-safe confirmation token */
async function generateToken(email: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(email + Date.now().toString() + Math.random().toString());
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    .slice(0, 32);
}

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`newsletter-subscribe:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;
  const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

  try {
    const body = await request.json();
    const parsed = SubscribeSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid request',
        details: parsed.error.issues.map(i => i.message)
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const { email, source, consent, name } = parsed.data;

    const normalizedEmail = email.toLowerCase().trim();
    const subscriberId = emailToDocId(normalizedEmail);

    // Check existing subscriber
    let existingDoc = null;
    try {
      existingDoc = await getDocument('subscribers', subscriberId);
    } catch (e) {
      console.log('[Newsletter] Could not check existing subscriber, will try to create');
    }

    if (existingDoc) {
      if (existingDoc.status === 'active') {
        return new Response(JSON.stringify({
          success: true,
          message: 'You are already subscribed!'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (existingDoc.status === 'unsubscribed' || existingDoc.status === 'pending_confirmation') {
        // Re-send confirmation for unsubscribed or pending users
        const token = await generateToken(normalizedEmail);
        await updateDocument('subscribers', subscriberId, {
          status: 'pending_confirmation',
          confirmationToken: token,
          consentTimestamp: new Date().toISOString(),
          consentSource: source,
          consentIp: clientId,
          updatedAt: new Date().toISOString()
        });

        if (RESEND_API_KEY) {
          await sendConfirmationEmail(RESEND_API_KEY, normalizedEmail, subscriberId, token, name);
        }

        return new Response(JSON.stringify({
          success: true,
          message: 'Please check your email to confirm your subscription.'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Create new subscriber with pending status
    const token = await generateToken(normalizedEmail);
    const subscriberData = {
      email: normalizedEmail,
      name: name || '',
      status: 'pending_confirmation',
      source,
      confirmationToken: token,
      consentTimestamp: new Date().toISOString(),
      consentSource: source,
      consentIp: clientId,
      subscribedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      emailsSent: 0,
      emailsOpened: 0,
      lastEmailSentAt: null
    };

    const createResult = await createDocumentIfNotExists('subscribers', subscriberId, subscriberData);

    if (!createResult.success && createResult.exists) {
      return new Response(JSON.stringify({
        success: true,
        message: 'Please check your email to confirm your subscription.'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Send confirmation email
    if (RESEND_API_KEY) {
      try {
        await sendConfirmationEmail(RESEND_API_KEY, normalizedEmail, subscriberId, token, name);
      } catch (emailError) {
        console.error('[Newsletter] Confirmation email failed:', emailError);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Please check your email to confirm your subscription.'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[Newsletter] Subscribe error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to subscribe. Please try again.'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

async function sendConfirmationEmail(
  apiKey: string, email: string, subscriberId: string, token: string, name?: string
): Promise<void> {
  const confirmUrl = `${SITE_URL}/api/newsletter/confirm/?id=${encodeURIComponent(subscriberId)}&token=${encodeURIComponent(token)}`;
  const greeting = name ? `Hi ${name},` : 'Hi there,';

  let response: Response;
  try {
    response = await fetchWithTimeout('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Fresh Wax <noreply@freshwax.co.uk>',
        to: email,
        subject: 'Confirm Your Subscription - Fresh Wax',
        html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #111; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <div style="text-align: center; margin-bottom: 30px;">
      <img src="${SITE_URL}/logo.webp" alt="Fresh Wax" style="height: 60px; background: white; padding: 10px; border-radius: 8px;">
    </div>
    <div style="background: #1a1a1a; border-radius: 12px; padding: 30px; color: #fff;">
      <h1 style="margin: 0 0 20px; font-size: 24px; color: #fff;">Confirm Your Subscription</h1>
      <p style="color: #ccc; line-height: 1.6; margin-bottom: 20px;">${greeting}</p>
      <p style="color: #ccc; line-height: 1.6; margin-bottom: 25px;">
        Thanks for subscribing to the Fresh Wax newsletter! Please confirm your email address by clicking the button below.
      </p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${confirmUrl}" style="display: inline-block; background: #dc2626; color: #fff; text-decoration: none; padding: 14px 30px; border-radius: 8px; font-weight: bold;">Confirm Subscription</a>
      </div>
      <p style="color: #888; font-size: 14px; margin-top: 30px; text-align: center;">
        If you didn't subscribe to Fresh Wax, you can safely ignore this email.
      </p>
    </div>
    <div style="text-align: center; margin-top: 30px; color: #666; font-size: 12px;">
      <p>&copy; ${new Date().getFullYear()} Fresh Wax. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`
      })
    }, 10000);
  } catch (fetchError) {
    console.error('[Newsletter] Resend fetch failed:', fetchError);
    return; // Subscription was created, email failure is non-blocking
  }

  if (!response.ok) {
    let errorBody: string | undefined;
    try { errorBody = await response.text(); } catch {}
    console.error('[Newsletter] Resend API error:', response.status, errorBody);
    return;
  }
}
