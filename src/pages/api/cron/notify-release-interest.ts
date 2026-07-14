// src/pages/api/cron/notify-release-interest.ts
// Daily job: email everyone on a release's free interest list ("notify me
// on release", no payment taken) once that release is out and live.
//
// Subscriptions come from POST /api/notify-release (releaseInterest
// collection). Each is deleted after a successful send — failures stay
// 'active' and retry on the next run.
//
// Trigger: called by the freshwax-cron worker daily at 02:00 UTC, right
// after release-preorders (paid pre-orders) so both audiences hear on the
// same morning.

import type { APIRoute } from 'astro';
import { queryCollection, getDocument, deleteDocument } from '../../../lib/firebase-rest';
import { brandedEmail } from '../../../lib/email-templates/branded';
import { sendResendEmail } from '../../../lib/email';
import { createLogger, errorResponse, successResponse, timingSafeCompare } from '../../../lib/api-utils';
import { SITE_URL } from '../../../lib/constants';

const log = createLogger('[cron/notify-release-interest]');

export const prerender = false;

const MAX_EMAILS_PER_RUN = 50;

function isLive(release: Record<string, unknown>): boolean {
  return release.status === 'live' || release.published === true;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals?.runtime?.env;

  const auth = request.headers.get('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const secret = env?.CRON_SECRET || import.meta.env.CRON_SECRET;
  if (!secret || !bearer || !timingSafeCompare(bearer, secret)) {
    return errorResponse('Unauthorized', 403);
  }

  const apiKey = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
  if (!apiKey) return errorResponse('RESEND_API_KEY not configured', 503);

  try {
    const now = Date.now();

    const subs = await queryCollection('releaseInterest', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'active' }],
      limit: 300,
      skipCache: true,
    }).catch(() => [] as Record<string, unknown>[]);

    // One release fetch per distinct releaseId
    const releaseCache = new Map<string, Record<string, unknown> | null>();
    async function fetchRelease(id: string): Promise<Record<string, unknown> | null> {
      if (!releaseCache.has(id)) {
        releaseCache.set(id, await getDocument('releases', id).catch(() => null));
      }
      return releaseCache.get(id) || null;
    }

    let sent = 0;
    let skipped = 0;
    const results: Record<string, string> = {};

    for (const sub of subs) {
      if (sent >= MAX_EMAILS_PER_RUN) break;

      const subId = String(sub.id);
      const releaseId = String(sub.releaseId || '');
      const email = String(sub.email || '');
      if (!releaseId || !email.includes('@')) {
        await deleteDocument('releaseInterest', subId).catch(() => {});
        continue;
      }

      const release = await fetchRelease(releaseId);
      if (!release) {
        // Release was deleted — drop the subscription quietly
        await deleteDocument('releaseInterest', subId).catch(() => {});
        skipped++;
        continue;
      }

      // Use the release's CURRENT date (labels can move release days)
      const releaseDate = release.releaseDate ? new Date(String(release.releaseDate)) : null;
      const isOut = !releaseDate || isNaN(releaseDate.getTime()) || releaseDate.getTime() <= now;
      if (!isOut || !isLive(release)) {
        skipped++;
        continue; // not out yet — try again next run
      }

      const artistName = String(release.artistName || release.artist || sub.artistName || '');
      const releaseName = String(release.releaseName || release.title || sub.releaseName || 'the release');
      const displayName = artistName ? `${artistName} - ${releaseName}` : releaseName;
      const itemUrl = `${SITE_URL}/item/${releaseId}/`;
      const artwork = String(release.coverArtUrl || release.artworkUrl || '');

      try {
        const body = `
          <p style="color:#fff;font-size:15px;margin:0 0 14px;">Easy,</p>
          <p style="color:#d1d5db;font-size:14px;line-height:1.6;margin:0 0 18px;">
            You asked us to give you a shout when this dropped — it's out now:
          </p>
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:18px;"><tr>
            ${artwork ? `<td width="72" style="vertical-align:middle;"><img src="${artwork}" alt="" width="64" height="64" style="border-radius:6px;object-fit:cover;display:block;" /></td>` : ''}
            <td style="vertical-align:middle;color:#fff;font-size:15px;font-weight:700;padding-left:4px;">${displayName}</td>
          </tr></table>
          <p style="margin:0 0 18px;">
            <a href="${itemUrl}" style="display:inline-block;background:#dc2626;color:#fff;font-weight:800;font-size:13px;text-decoration:none;padding:10px 18px;border-radius:6px;letter-spacing:0.5px;">LISTEN &amp; BUY</a>
          </p>
          <p style="color:#6b7280;font-size:12px;line-height:1.5;margin:0;">
            You're getting this one-off email because you set a release reminder on Fresh Wax.
            No more emails about this release either way.
          </p>`;

        const result = await sendResendEmail({
          apiKey: String(apiKey),
          from: 'Fresh Wax <noreply@freshwax.co.uk>',
          to: email,
          subject: `Out now: ${displayName}`,
          html: brandedEmail({
            stripHeadline: '🔥 OUT NOW',
            stripSubtitle: displayName,
            body,
          }),
          replyTo: 'contact@freshwax.co.uk',
          template: 'release-interest',
          db: env?.DB,
        });

        if (result.success) {
          await deleteDocument('releaseInterest', subId);
          sent++;
          results[`${releaseId}:${subId}`] = 'sent';
        } else {
          results[`${releaseId}:${subId}`] = `failed: ${result.error}`;
        }
      } catch (err: unknown) {
        results[`${releaseId}:${subId}`] = `error: ${err instanceof Error ? err.message : 'unknown'}`;
        log.error(`Failed for sub ${subId}:`, err);
      }
    }

    log.info(`Release interest: ${sent} sent, ${skipped} not due (${subs.length} active subs)`);
    return successResponse({ active: subs.length, sent, skipped, results });
  } catch (error: unknown) {
    log.error('Error:', error);
    return errorResponse(error instanceof Error ? error.message : 'notify-release-interest cron failed', 500);
  }
};
