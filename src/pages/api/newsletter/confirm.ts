// src/pages/api/newsletter/confirm.ts
// Double opt-in confirmation endpoint
// Validates token, activates subscription, sends welcome email

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, RateLimiters } from '../../../lib/rate-limit';
import { SITE_URL } from '../../../lib/constants';
import { fetchWithTimeout } from '../../../lib/api-utils';
import { emailWrapper, ctaButton } from '../../../lib/email-wrapper';

const ConfirmSchema = z.object({
  id: z.string().min(1).max(500),
  token: z.string().min(1).max(500),
});

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, redirect }) => {
  // Rate limit: 10 per 15 minutes to prevent abuse (sends welcome email)
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`newsletter-confirm:${clientId}`, RateLimiters.auth);
  if (!rateLimit.allowed) {
    return redirect('/newsletter/?error=rate-limited');
  }

  const url = new URL(request.url);
  const parsed = ConfirmSchema.safeParse({
    id: url.searchParams.get('id') ?? '',
    token: url.searchParams.get('token') ?? '',
  });
  if (!parsed.success) {
    return redirect('/newsletter/?error=invalid-link');
  }
  const subscriberId = parsed.data.id;
  const token = parsed.data.token;

  try {
    const subscriber = await getDocument('subscribers', subscriberId);

    if (!subscriber) {
      return redirect('/newsletter/?error=not-found');
    }

    if (subscriber.status === 'active') {
      return redirect('/newsletter/?confirmed=already');
    }

    if (subscriber.confirmationToken !== token) {
      return redirect('/newsletter/?error=invalid-token');
    }

    // Activate subscription
    await updateDocument('subscribers', subscriberId, {
      status: 'active',
      confirmedAt: new Date().toISOString(),
      confirmationToken: '',
      updatedAt: new Date().toISOString()
    });

    // Send welcome email
    const env = locals.runtime.env;
    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (RESEND_API_KEY) {
      try {
        await sendWelcomeEmail(RESEND_API_KEY, subscriber.email, subscriber.name);
      } catch (e: unknown) {
        console.error('[Newsletter] Welcome email failed:', e);
      }
    }

    return redirect('/newsletter/?confirmed=success');

  } catch (error: unknown) {
    console.error('[Newsletter] Confirm error:', error);
    return redirect('/newsletter/?error=server-error');
  }
};

async function sendWelcomeEmail(apiKey: string, email: string, name?: string): Promise<void> {
  const greeting = name ? `Hi ${name},` : 'Hi there,';

  const welcomeContent = `
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;" class="text-primary">
                ${greeting}
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 20px; line-height: 1.6;" class="text-secondary">
                Your subscription is now confirmed. You'll be the first to know about:
              </p>

              <ul style="color: #a3a3a3; line-height: 1.8; margin: 0 0 25px; padding-left: 20px;" class="text-secondary">
                <li>New jungle &amp; drum and bass releases</li>
                <li>Exclusive DJ mixes</li>
                <li>Limited vinyl pressings</li>
                <li>Fresh merch drops</li>
                <li>Live stream announcements</li>
              </ul>

              ${ctaButton('Browse Latest Releases', SITE_URL + '/releases/')}`;

  const welcomeHtml = emailWrapper(welcomeContent, {
    title: 'Welcome to Fresh Wax',
    headerText: 'Welcome to the Fresh Wax Family!',
    footerExtra: `<p style="color: #737373; font-size: 12px; margin: 0; text-align: center;" class="text-muted"><a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(email)}" style="color: #737373; text-decoration: underline;">Unsubscribe</a></p>`,
  });

  await fetchWithTimeout('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Fresh Wax <noreply@freshwax.co.uk>',
      to: email,
      subject: 'Welcome to Fresh Wax!',
      html: welcomeHtml
    })
  }, 10000);
}
