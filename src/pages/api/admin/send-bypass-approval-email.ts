// src/pages/api/admin/send-bypass-approval-email.ts
// DJ lobby bypass approval email — fires when an admin grants a DJ
// permission to go live without meeting the standard requirements
// (10 mix likes etc). Uses the on-brand white FRESH WAX header +
// red strip + dark panel template to match the digital sale +
// merch sale notifications.

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { SITE_URL } from '../../../lib/constants';
import { fetchWithTimeout, ApiErrors, createLogger, successResponse, jsonResponse } from '../../../lib/api-utils';
import { esc } from '../../../lib/email-wrapper';
import { brandedEmail, brandedCta } from '../../../lib/email-templates/branded';

const log = createLogger('[send-bypass-approval-email]');

const schema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  reason: z.string().optional(),
}).strip();

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`send-bypass-approval-email:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals.runtime.env;
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });

  try {
    const body = await request.json().catch(() => ({}));
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const parsed = schema.safeParse(body);
    if (!parsed.success) return ApiErrors.badRequest('Invalid input');
    const { email, name } = parsed.data;

    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
    if (!RESEND_API_KEY) {
      return jsonResponse({ success: false, message: 'Email service not configured' });
    }

    const displayName = name || email.split('@')[0];
    const html = brandedEmail({
      stripHeadline: '🎵 YOU&rsquo;RE APPROVED!',
      body: `
        <p style="font-size:18px;line-height:1.5;margin:0 0 12px;color:#fff;font-weight:700;">Ez ${esc(displayName)} 👋</p>
        <p style="font-size:15px;line-height:1.5;margin:0 0 16px;color:#d1d5db;">You've been approved to use the DJ Lobby and Go Live on Fresh Wax. The standard requirements (10 mix likes) have been bypassed for your account &mdash; you can broadcast immediately.</p>
        <p style="font-size:15px;line-height:1.5;margin:0 0 24px;color:#d1d5db;">Head over to the DJ Lobby whenever you're ready to set up your stream. You can use OBS, BUTT, your phone or tablet, or relay an external station.</p>
        ${brandedCta('Go to DJ Lobby', SITE_URL + '/account/dj-lobby/')}
        <p style="font-size:12px;line-height:1.5;color:#9ca3af;margin:0;text-align:center;">First time setting up? Check the streaming guide in the DJ Lobby for OBS / BUTT settings.</p>
      `,
    });

    const response = await fetchWithTimeout('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Fresh Wax <noreply@freshwax.co.uk>',
        to: email,
        bcc: ['freshwaxonline@gmail.com'],
        subject: '🎙️ You’re approved to go live on Fresh Wax',
        html,
      }),
    }, 10000);

    if (!response.ok) {
      const err = await response.json().catch(() => ({ message: 'Failed to send' }));
      log.error('Resend error:', err);
      return ApiErrors.serverError(err.message || 'Failed to send email');
    }
    const result = await response.json();
    log.info('Bypass approval email sent to:', email);
    return successResponse({ messageId: result.id });
  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to send bypass approval email');
  }
};
