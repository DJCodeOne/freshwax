// src/pages/api/newsletter/confirm.ts
// Double opt-in confirmation endpoint
// Validates token, activates subscription, sends welcome email

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument } from '../../../lib/firebase-rest';
import { SITE_URL } from '../../../lib/constants';
import { fetchWithTimeout } from '../../../lib/api-utils';

const ConfirmSchema = z.object({
  id: z.string().min(1).max(500),
  token: z.string().min(1).max(500),
});

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, redirect }) => {
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
      } catch (e) {
        console.error('[Newsletter] Welcome email failed:', e);
      }
    }

    return redirect('/newsletter/?confirmed=success');

  } catch (error) {
    console.error('[Newsletter] Confirm error:', error);
    return redirect('/newsletter/?error=server-error');
  }
};

async function sendWelcomeEmail(apiKey: string, email: string, name?: string): Promise<void> {
  const greeting = name ? `Hi ${name},` : 'Hi there,';

  await fetchWithTimeout('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Fresh Wax <noreply@freshwax.co.uk>',
      to: email,
      subject: 'Welcome to Fresh Wax! 🎵',
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
      <h1 style="margin: 0 0 20px; font-size: 24px; color: #fff;">Welcome to the Fresh Wax family!</h1>
      <p style="color: #ccc; line-height: 1.6; margin-bottom: 20px;">${greeting}</p>
      <p style="color: #ccc; line-height: 1.6; margin-bottom: 20px;">
        Your subscription is now confirmed. You'll be the first to know about:
      </p>
      <ul style="color: #ccc; line-height: 1.8; margin-bottom: 25px; padding-left: 20px;">
        <li>New jungle &amp; drum and bass releases</li>
        <li>Exclusive DJ mixes</li>
        <li>Limited vinyl pressings</li>
        <li>Fresh merch drops</li>
        <li>Live stream announcements</li>
      </ul>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${SITE_URL}/releases/" style="display: inline-block; background: #dc2626; color: #fff; text-decoration: none; padding: 14px 30px; border-radius: 8px; font-weight: bold;">Browse Latest Releases</a>
      </div>
    </div>
    <div style="text-align: center; margin-top: 30px; color: #666; font-size: 12px;">
      <p>&copy; ${new Date().getFullYear()} Fresh Wax. All rights reserved.</p>
      <p style="margin-top: 10px;">
        <a href="${SITE_URL}/unsubscribe?email=${encodeURIComponent(email)}" style="color: #666;">Unsubscribe</a>
      </p>
    </div>
  </div>
</body>
</html>`
    })
  }, 10000);
}
