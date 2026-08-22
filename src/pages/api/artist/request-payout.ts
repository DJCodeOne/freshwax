// src/pages/api/artist/request-payout.ts
// Lets a partner ask for their pending balance to be paid out. Payouts are
// run manually by the operator, so this records a payoutRequests doc and
// emails the operator — partners no longer have to chase by DM.

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, queryCollection, addDocument } from '../../../lib/firebase-rest';
import { verifyUserToken } from '../../../lib/firebase/verify';
import { sendResendEmail } from '../../../lib/email';
import { brandedEmail } from '../../../lib/email-templates/branded';
import { escapeHtml } from '../../../lib/escape-html';
import { formatPrice } from '../../../lib/format-utils';
import { SITE_URL } from '../../../lib/constants';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const requestPayoutSchema = z.object({
  idToken: z.string().min(1, 'Authentication required').max(5000),
}).strip();

const log = createLogger('artist/request-payout');

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`request-payout:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  try {
    const body = await request.json().catch(() => ({}));
    const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const parsed = requestPayoutSchema.safeParse({ idToken: body.idToken || bearer });
    if (!parsed.success) return ApiErrors.unauthorized('Authentication required');

    const uid = await verifyUserToken(parsed.data.idToken);
    if (!uid) return ApiErrors.unauthorized('Invalid session');

    const artist = await getDocument('artists', uid);
    if (!artist) return ApiErrors.notFound('No artist account found');

    // Equality-only filters — no composite index needed.
    const pendingRows = await queryCollection('pendingPayouts', {
      filters: [
        { field: 'artistId', op: 'EQUAL', value: uid },
        { field: 'status', op: 'EQUAL', value: 'pending' },
      ],
      limit: 100,
    });
    const amount = pendingRows.reduce((s: number, r: Record<string, unknown>) => s + (Number(r.amount) || 0), 0);
    if (pendingRows.length === 0 || amount <= 0) {
      return ApiErrors.badRequest('Nothing awaiting payout');
    }

    // One open request per artist — repeat clicks acknowledge, not duplicate.
    const existing = await queryCollection('payoutRequests', {
      filters: [
        { field: 'artistId', op: 'EQUAL', value: uid },
        { field: 'status', op: 'EQUAL', value: 'open' },
      ],
      limit: 1,
    });
    if (existing.length > 0) {
      return successResponse({ alreadyRequested: true, requestedAt: existing[0].createdAt, amount });
    }

    const now = new Date().toISOString();
    const artistName = String(artist.artistName || artist.name || 'Unknown artist');
    await addDocument('payoutRequests', {
      artistId: uid,
      artistName,
      artistEmail: String(artist.email || ''),
      amount,
      rowCount: pendingRows.length,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    });

    // Notify the operator — best-effort; the stored request is the source of truth.
    const env = locals.runtime.env;
    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
    if (RESEND_API_KEY) {
      try {
        const html = brandedEmail({
          stripHeadline: '💸 PAYOUT REQUEST',
          stripSubtitle: artistName,
          body:
            `<p style="font-size:16px;line-height:1.5;margin:0 0 16px;color:#e5e7eb;"><strong style="color:#fff;">${escapeHtml(artistName)}</strong> has requested their pending payout.</p>` +
            `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px;background:#1f2937;border:1px solid #374151;border-radius:8px;"><tr><td style="padding:16px 20px;">` +
            `<table cellpadding="0" cellspacing="0" border="0" width="100%">` +
            `<tr><td style="color:#9ca3af;font-size:13px;padding:4px 0;">Amount owed</td><td style="color:#16a34a;font-weight:700;font-size:15px;padding:4px 0;text-align:right;">${formatPrice(amount)}</td></tr>` +
            `<tr><td style="color:#9ca3af;font-size:13px;padding:4px 0;">Pending orders</td><td style="color:#fff;font-size:13px;padding:4px 0;text-align:right;">${pendingRows.length}</td></tr>` +
            `<tr><td style="color:#9ca3af;font-size:13px;padding:4px 0;">Contact</td><td style="color:#fff;font-size:13px;padding:4px 0;text-align:right;">${escapeHtml(String(artist.email || 'no email on file'))}</td></tr>` +
            `</table></td></tr></table>` +
            `<p style="font-size:14px;line-height:1.5;margin:0;color:#d1d5db;">Pay them out, then mark the orders paid and close the request in <a href="${SITE_URL}/admin/payments/" style="color:#dc2626;">Admin → Payments</a>.</p>`,
        });
        await sendResendEmail({
          apiKey: RESEND_API_KEY,
          from: 'Fresh Wax <orders@freshwax.co.uk>',
          to: ['freshwaxonline@gmail.com'],
          subject: `Payout request: ${artistName} — ${formatPrice(amount)}`,
          html,
          template: 'payout-request-admin',
          db: env?.DB,
        });
      } catch (emailError: unknown) {
        log.error('Payout request email failed:', emailError);
      }
    }

    return successResponse({ requested: true, amount });
  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Unknown error');
  }
};
