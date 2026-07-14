// src/pages/api/cron/release-preorders.ts
// Daily job: complete pre-orders whose release date has arrived.
//
// Orders containing pre-order items are created with status
// 'awaiting_release' (see lib/order/creation.ts). Nothing else ever
// transitions them — this job flips each one to its normal post-payment
// status once its preOrderDeliveryDate passes, and emails the buyer a
// "your music is ready" link to their downloads.
//
// The download embargo itself does NOT depend on this job: the download
// endpoints gate on each item's releaseDate, so music unlocks on time
// even if a run is missed. This job handles lifecycle + notification.
//
// Trigger: called by the freshwax-cron worker daily at 02:00 UTC.
// Query shape: single equality on status (auto index) — no composite
// index needed; date filtering happens in-process.

import type { APIRoute } from 'astro';
import { queryCollection, updateDocument } from '../../../lib/firebase-rest';
import { brandedEmail } from '../../../lib/email-templates/branded';
import { sendResendEmail } from '../../../lib/email';
import { createLogger, errorResponse, successResponse, timingSafeCompare } from '../../../lib/api-utils';
import { SITE_URL } from '../../../lib/constants';

const log = createLogger('[cron/release-preorders]');

export const prerender = false;

const MAX_PER_RUN = 50;

// Latest release date across the order's pre-order items; falls back to the
// stored preOrderDeliveryDate. Null means "no usable date" — release it
// (better to deliver than to strand the order forever).
function orderReleaseDate(order: Record<string, unknown>): Date | null {
  const items = (order.items || []) as Record<string, unknown>[];
  const dates = items
    .filter((i) => i.isPreOrder && i.releaseDate)
    .map((i) => new Date(String(i.releaseDate)))
    .filter((d) => !isNaN(d.getTime()));
  if (dates.length > 0) return new Date(Math.max(...dates.map((d) => d.getTime())));
  const stored = order.preOrderDeliveryDate ? new Date(String(order.preOrderDeliveryDate)) : null;
  return stored && !isNaN(stored.getTime()) ? stored : null;
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

  try {
    const now = Date.now();

    const awaiting = await queryCollection('orders', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'awaiting_release' }],
      limit: 200,
      skipCache: true,
    }).catch(() => [] as Record<string, unknown>[]);

    const due = awaiting
      .filter((o) => {
        const date = orderReleaseDate(o);
        return !date || date.getTime() <= now;
      })
      .slice(0, MAX_PER_RUN);

    let released = 0;
    let emailed = 0;
    const results: Record<string, string> = {};

    for (const order of due) {
      const orderId = String(order.id);
      const orderNumber = String(order.orderNumber || orderId);
      try {
        // Same post-payment status a non-preorder order would have received
        const newStatus = order.hasPhysicalItems ? 'processing' : 'completed';
        await updateDocument('orders', orderId, {
          status: newStatus,
          orderStatus: newStatus,
          preOrderReleasedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        released++;
        results[orderNumber] = `released -> ${newStatus}`;

        const customer = (order.customer || {}) as Record<string, unknown>;
        const email = String(customer.email || '');
        if (apiKey && email.includes('@')) {
          const firstName = String(customer.firstName || '').trim();
          const items = ((order.items || []) as Record<string, unknown>[]).filter((i) => i.isPreOrder);
          const itemList = items
            .map((i) => `<li style="color:#fff;font-size:14px;font-weight:600;margin:0 0 6px;">${String(i.name || i.title || 'Your release')}</li>`)
            .join('');

          const body = `
            <p style="color:#fff;font-size:15px;margin:0 0 14px;">${firstName ? `Easy ${firstName},` : 'Easy,'}</p>
            <p style="color:#d1d5db;font-size:14px;line-height:1.6;margin:0 0 18px;">
              Release day! Your pre-order from order <strong style="color:#fff;">${orderNumber}</strong>
              is out now and your downloads are unlocked:
            </p>
            <ul style="margin:0 0 18px;padding-left:18px;">${itemList}</ul>
            <p style="margin:0 0 18px;">
              <a href="${SITE_URL}/account/dashboard/#downloads" style="display:inline-block;background:#dc2626;color:#fff;font-weight:800;font-size:13px;text-decoration:none;padding:10px 18px;border-radius:6px;letter-spacing:0.5px;">GET YOUR MUSIC</a>
            </p>
            <p style="color:#6b7280;font-size:12px;line-height:1.5;margin:0;">
              Thanks for backing the release before it dropped — that support goes straight to the
              artists and labels pushing this sound forward.
            </p>`;

          const result = await sendResendEmail({
            apiKey: String(apiKey),
            from: 'Fresh Wax <noreply@freshwax.co.uk>',
            to: email,
            subject: `It's out! Your pre-order is ready to download`,
            html: brandedEmail({
              stripHeadline: '🔥 RELEASE DAY',
              stripSubtitle: `Order ${orderNumber}`,
              body,
            }),
            replyTo: 'contact@freshwax.co.uk',
            template: 'preorder-release',
            db: env?.DB,
          });
          if (result.success) {
            emailed++;
          } else {
            results[orderNumber] += ` (email failed: ${result.error})`;
          }
        }
      } catch (err: unknown) {
        results[orderNumber] = `error: ${err instanceof Error ? err.message : 'unknown'}`;
        log.error(`Failed for order ${orderNumber}:`, err);
      }
    }

    log.info(`Pre-orders released: ${released}/${due.length} due (${awaiting.length} awaiting), ${emailed} emails`);
    return successResponse({ awaiting: awaiting.length, due: due.length, released, emailed, results });
  } catch (error: unknown) {
    log.error('Error:', error);
    return errorResponse(error instanceof Error ? error.message : 'release-preorders cron failed', 500);
  }
};
