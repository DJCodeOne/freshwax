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
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#000;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#000;"><tr><td align="center" style="padding:40px 20px;">
    <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;">
      <tr><td style="background:#fff;padding:32px 24px;border-radius:12px 12px 0 0;text-align:center;border:2px solid #dc2626;border-bottom:none;">
        <div style="font-size:32px;font-weight:900;letter-spacing:2px;line-height:1;"><span style="color:#000;">FRESH</span> <span style="color:#dc2626;">WAX</span></div>
        <div style="font-size:11px;color:#666;margin-top:6px;letter-spacing:3px;font-weight:600;">JUNGLE &bull; DRUM AND BASS</div>
      </td></tr>
      <tr><td style="background:#dc2626;padding:18px 24px;text-align:center;border-left:2px solid #dc2626;border-right:2px solid #dc2626;">
        <div style="font-size:20px;font-weight:800;color:#fff;letter-spacing:1px;">🎙️ YOU'RE APPROVED TO GO LIVE!</div>
      </td></tr>
      <tr><td style="background:#111;padding:32px 28px;border-left:2px solid #dc2626;border-right:2px solid #dc2626;border-bottom:2px solid #dc2626;border-radius:0 0 12px 12px;">
        <p style="font-size:18px;line-height:1.5;margin:0 0 12px;color:#fff;font-weight:700;">Ez ${esc(displayName)} 👋</p>
        <p style="font-size:15px;line-height:1.5;margin:0 0 16px;color:#d1d5db;">An admin has approved you for the Fresh Wax DJ Lobby. The standard requirements (10 mix likes) have been bypassed for your account &mdash; you can broadcast immediately.</p>
        <p style="font-size:15px;line-height:1.5;margin:0 0 24px;color:#d1d5db;">Head over to the DJ Lobby whenever you're ready to set up your stream. You can use OBS, BUTT, or relay an external station.</p>
        <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center" style="padding:6px 0 22px;">
          <a href="${SITE_URL}/account/dj-lobby/" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:15px;letter-spacing:0.5px;text-transform:uppercase;">Go to DJ Lobby</a>
        </td></tr></table>
        <p style="font-size:12px;line-height:1.5;color:#9ca3af;margin:0;text-align:center;">First time setting up? Check the streaming guide on your dashboard for OBS / BUTT walkthroughs.</p>
      </td></tr>
      <tr><td align="center" style="padding:22px 0 0;">
        <div style="color:#9ca3af;font-size:12px;">Automated notification from FreshWax</div>
        <div style="margin-top:6px;"><a href="${SITE_URL}" style="font-size:12px;text-decoration:none;font-weight:600;"><span style="color:#fff;">fresh</span><span style="color:#dc2626;">wax</span><span style="color:#fff;">.co.uk</span></a></div>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

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
