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
import { createLogger, fetchWithTimeout, ApiErrors, successResponse } from '../../../lib/api-utils';

const log = createLogger('[newsletter]');
import { emailWrapper, ctaButton } from '../../../lib/email-wrapper';

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
      return ApiErrors.badRequest('Invalid request');
    }
    const { email, source, consent, name } = parsed.data;

    const normalizedEmail = email.toLowerCase().trim();
    const subscriberId = emailToDocId(normalizedEmail);

    // Check existing subscriber
    let existingDoc = null;
    try {
      existingDoc = await getDocument('subscribers', subscriberId);
    } catch (e: unknown) {
      log.info('[Newsletter] Could not check existing subscriber, will try to create');
    }

    if (existingDoc) {
      if (existingDoc.status === 'active') {
        return successResponse({ message: 'You are already subscribed!' });
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

        return successResponse({ message: 'Please check your email to confirm your subscription.' });
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
      return successResponse({ message: 'Please check your email to confirm your subscription.' });
    }

    // Send confirmation email
    if (RESEND_API_KEY) {
      try {
        await sendConfirmationEmail(RESEND_API_KEY, normalizedEmail, subscriberId, token, name);
      } catch (emailError: unknown) {
        log.error('[Newsletter] Confirmation email failed:', emailError);
      }
    }

    return successResponse({ message: 'Please check your email to confirm your subscription.' });

  } catch (error: unknown) {
    log.error('[Newsletter] Subscribe error:', error);
    return ApiErrors.serverError('Failed to subscribe. Please try again.');
  }
};

async function sendConfirmationEmail(
  apiKey: string, email: string, subscriberId: string, token: string, name?: string
): Promise<void> {
  const confirmUrl = `${SITE_URL}/api/newsletter/confirm/?id=${encodeURIComponent(subscriberId)}&token=${encodeURIComponent(token)}`;
  const greeting = name ? `Hi ${name},` : 'Hi there,';

  const confirmContent = `
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;" class="text-primary">
                ${greeting}
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 25px; line-height: 1.6;" class="text-secondary">
                Thanks for subscribing to the Fresh Wax newsletter! Please confirm your email address by clicking the button below.
              </p>

              ${ctaButton('Confirm Subscription', confirmUrl)}

              <p style="color: #737373; font-size: 14px; margin: 0; text-align: center; line-height: 1.6;" class="text-muted">
                If you didn't subscribe to Fresh Wax, you can safely ignore this email.
              </p>`;

  const confirmHtml = emailWrapper(confirmContent, {
    title: 'Confirm Your Subscription',
    headerText: 'Confirm Your Subscription',
  });

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
        html: confirmHtml
      })
    }, 10000);
  } catch (fetchError: unknown) {
    log.error('[Newsletter] Resend fetch failed:', fetchError);
    return; // Subscription was created, email failure is non-blocking
  }

  if (!response.ok) {
    let errorBody: string | undefined;
    try { errorBody = await response.text(); } catch (_e: unknown) { /* non-critical: could not read error response body */ }
    log.error('[Newsletter] Resend API error:', response.status, errorBody);
    return;
  }
}
