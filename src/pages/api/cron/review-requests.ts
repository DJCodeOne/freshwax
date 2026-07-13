// src/pages/api/cron/review-requests.ts
// Daily job: email buyers ~7 days after their order with tokenised review
// links for each store product they bought (merch + releases; crates items
// excluded — those are seller-owned second-hand records).
//
// Why: review stars (aggregateRating) in product snippets are the single
// biggest SERP click-through lever, and GSC flags our products as missing
// them. Only verified purchasers get links, so the schema stays legitimate.
//
// Trigger: chained from the daily backup-d1 cron alongside indexnow.
// Query shape: single inequality on createdAt (auto index), everything else
// filtered in-process — avoids the Firestore composite-index trap.

import type { APIRoute } from 'astro';
import { queryCollection, updateDocument } from '../../../lib/firebase-rest';
import { reviewToken, reviewableOrderItems } from '../../../lib/reviews';
import { brandedEmail } from '../../../lib/email-templates/branded';
import { sendResendEmail } from '../../../lib/email';
import { createLogger, errorResponse, successResponse, timingSafeCompare } from '../../../lib/api-utils';
import { SITE_URL } from '../../../lib/constants';

const log = createLogger('[cron/review-requests]');

export const prerender = false;

const MIN_AGE_DAYS = 7;   // give physical orders time to arrive
const MAX_AGE_DAYS = 60;  // don't nag about ancient orders
const MAX_EMAILS_PER_RUN = 15;

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
    const windowStart = new Date(now - MAX_AGE_DAYS * 24 * 3600 * 1000).toISOString();
    const cutoff = new Date(now - MIN_AGE_DAYS * 24 * 3600 * 1000).toISOString();

    // Single-inequality query (no composite index needed); filter the rest here
    const orders = await queryCollection('orders', {
      filters: [{ field: 'createdAt', op: 'GREATER_THAN', value: windowStart }],
      limit: 300,
      skipCache: true,
    }).catch(() => [] as Record<string, unknown>[]);

    const candidates = orders.filter((o) => {
      if (o.reviewRequestSentAt) return false;
      if (String(o.createdAt) > cutoff) return false; // younger than 7 days
      const status = String(o.status || o.orderStatus || '');
      if (!['completed', 'processing', 'shipped', 'delivered'].includes(status)) return false;
      const email = String((o.customer as Record<string, unknown>)?.email || '');
      if (!email || !email.includes('@')) return false;
      return reviewableOrderItems(o).length > 0;
    }).slice(0, MAX_EMAILS_PER_RUN);

    let sent = 0;
    const results: Record<string, string> = {};

    for (const order of candidates) {
      const orderId = String(order.id);
      const customer = (order.customer || {}) as Record<string, unknown>;
      const email = String(customer.email);
      const firstName = String(customer.firstName || '').trim();
      const items = reviewableOrderItems(order);

      try {
        const itemRows = await Promise.all(items.map(async (item) => {
          const token = await reviewToken(env, orderId, item.productId);
          const link = `${SITE_URL}/review/?o=${encodeURIComponent(orderId)}&p=${encodeURIComponent(item.productId)}&t=${token}`;
          return `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:12px;"><tr>
            ${item.image ? `<td width="56" style="vertical-align:middle;"><img src="${item.image}" alt="" width="48" height="48" style="border-radius:6px;object-fit:cover;display:block;" /></td>` : ''}
            <td style="vertical-align:middle;color:#fff;font-size:14px;font-weight:600;padding-right:8px;">${item.name}</td>
            <td width="120" style="vertical-align:middle;text-align:right;">
              <a href="${link}" style="display:inline-block;background:#dc2626;color:#fff;font-weight:800;font-size:12px;text-decoration:none;padding:8px 14px;border-radius:6px;letter-spacing:0.5px;">RATE IT ★</a>
            </td>
          </tr></table>`;
        }));

        const body = `
          <p style="color:#fff;font-size:15px;margin:0 0 14px;">${firstName ? `Easy ${firstName},` : 'Easy,'}</p>
          <p style="color:#d1d5db;font-size:14px;line-height:1.6;margin:0 0 18px;">
            Hope order <strong style="color:#fff;">${String(order.orderNumber || '')}</strong> is treating you right.
            Got 30 seconds? A quick rating helps other junglists know what's good — and it directly supports
            the labels and artists behind it.
          </p>
          ${itemRows.join('')}
          <p style="color:#6b7280;font-size:12px;line-height:1.5;margin:18px 0 0;">
            These links are personal to your order — no login needed. If something wasn't right with your
            order, just reply to this email instead and we'll sort it.
          </p>`;

        const result = await sendResendEmail({
          apiKey: String(apiKey),
          from: 'Fresh Wax <noreply@freshwax.co.uk>',
          to: email,
          subject: `How's the order? Rate your Fresh Wax pickup ⭐`,
          html: brandedEmail({
            stripHeadline: '⭐ RATE YOUR ORDER',
            stripSubtitle: `Order ${String(order.orderNumber || '')}`,
            body,
          }),
          replyTo: 'contact@freshwax.co.uk',
          template: 'review-request',
          db: env?.DB,
        });

        if (result.success) {
          await updateDocument('orders', orderId, {
            reviewRequestSentAt: new Date().toISOString(),
          });
          sent++;
          results[String(order.orderNumber)] = 'sent';
        } else {
          results[String(order.orderNumber)] = `failed: ${result.error}`;
        }
      } catch (err: unknown) {
        results[String(order.orderNumber)] = `error: ${err instanceof Error ? err.message : 'unknown'}`;
        log.error(`Failed for order ${order.orderNumber}:`, err);
      }
    }

    log.info(`Review requests: ${sent}/${candidates.length} sent (${orders.length} orders scanned)`);
    return successResponse({ scanned: orders.length, candidates: candidates.length, sent, results });
  } catch (error: unknown) {
    log.error('Error:', error);
    return errorResponse(error instanceof Error ? error.message : 'review-requests cron failed', 500);
  }
};
