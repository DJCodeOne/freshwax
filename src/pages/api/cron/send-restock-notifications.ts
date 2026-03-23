// src/pages/api/cron/send-restock-notifications.ts
// Cron: 0 */6 * * * (every 6 hours)
// Dashboard: Cloudflare Pages > Settings > Cron Triggers
//
// Process and send restock notifications.
// Checks restockNotifications collection for active subscriptions,
// looks up current stock levels, and emails users when items are back in stock.

import type { APIRoute } from 'astro';
import { queryCollection, getDocument, deleteDocument } from '../../../lib/firebase-rest';
import { SITE_URL } from '../../../lib/constants';
import { fetchWithTimeout, ApiErrors, createLogger, timingSafeCompare, successResponse } from '../../../lib/api-utils';
import { acquireCronLock, releaseCronLock } from '../../../lib/cron-lock';
import { TIMEOUTS } from '../../../lib/timeouts';

const log = createLogger('restock-notifications');

export const prerender = false;

const MAX_NOTIFICATIONS_PER_RUN = 50;
const EMAIL_BATCH_SIZE = 5;

interface PendingEmail {
  sub: Record<string, unknown>;
  productName: string;
  productUrl: string;
  productId: string;
}

function buildRestockEmailHtml(productName: string, productUrl: string, variantKey: string | undefined, email: string, productId: string): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #0a0a0a; padding: 40px; color: #fff;">
      <h1 style="color: #22c55e;">Back in Stock!</h1>
      <p>Great news! An item you were waiting for is back in stock:</p>

      <div style="background-color: #1f1f1f; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <h2 style="margin: 0 0 10px; color: #fff;">${productName}</h2>
        ${variantKey ? `<p style="margin: 0; color: #a3a3a3;">Variant: ${variantKey.replace('_', ' / ')}</p>` : ''}
      </div>

      <p style="text-align: center; margin: 30px 0;">
        <a href="${productUrl}" style="display: inline-block; background: #dc2626; color: #fff; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600;">
          Shop Now
        </a>
      </p>

      <p style="color: #737373; font-size: 13px; margin-top: 30px;">
        Stock is limited - grab it before it's gone!
      </p>

      <p style="color: #737373; font-size: 12px; margin-top: 20px; border-top: 1px solid #262626; padding-top: 20px;">
        You received this email because you signed up for back-in-stock notifications.<br>
        <a href="${SITE_URL}/api/notify-restock/?email=${encodeURIComponent(email)}&productId=${productId}&action=unsubscribe" style="color: #737373;">Unsubscribe</a>
      </p>
    </div>
  `;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const startTime = Date.now();
  log.info('[Restock Notifications] ========== CRON JOB STARTED ==========');

  const env = locals.runtime.env;

  // Verify authorization
  const authHeader = request.headers.get('Authorization');
  const cronSecret = env?.CRON_SECRET || import.meta.env.CRON_SECRET;
  const adminKey = env?.ADMIN_KEY || import.meta.env.ADMIN_KEY;
  const xAdminKey = request.headers.get('X-Admin-Key');

  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const isAuthorized =
    (cronSecret && token && timingSafeCompare(token, cronSecret)) ||
    (adminKey && xAdminKey && timingSafeCompare(xAdminKey, adminKey));

  if (!isAuthorized) {
    return ApiErrors.unauthorized('Unauthorized');
  }

  const db = env?.DB;
  if (db) {
    const locked = await acquireCronLock(db, 'send-restock-notifications');
    if (!locked) {
      return ApiErrors.conflict('Job already running');
    }
  }

  try {
  const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

  if (!RESEND_API_KEY) {
    return successResponse({ skipped: true,
      reason: 'Email not configured' });
  }

  try {
    // Get all active subscriptions
    const subscriptions = await queryCollection('restockNotifications', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'active' }],
      limit: 200
    });

    log.info('[Restock Notifications] Found', subscriptions.length, 'active subscriptions');

    const results = {
      checked: 0,
      notified: 0,
      stillOutOfStock: 0,
      errors: 0
    };

    // Group by product to minimize lookups
    const byProduct: Record<string, Record<string, unknown>[]> = {};
    for (const sub of subscriptions) {
      const key = `${sub.productType}:${sub.productId}`;
      if (!byProduct[key]) byProduct[key] = [];
      byProduct[key].push(sub);
    }

    // Phase 1: Check stock and collect emails to send
    const pendingEmails: PendingEmail[] = [];

    for (const [key, subs] of Object.entries(byProduct)) {
      if (pendingEmails.length >= MAX_NOTIFICATIONS_PER_RUN) break;

      const [productType, productId] = key.split(':');
      results.checked++;

      try {
        let isInStock = false;
        let productName = String(subs[0].productName || '');
        let productUrl = '';

        if (productType === 'merch') {
          const product = await getDocument('merch', productId);
          if (product) {
            productName = String(product.name || product.productName || productName);
            productUrl = `${SITE_URL}/merch?product=${productId}`;

            // Check if any variant is in stock
            if (product.variantStock) {
              for (const sub of subs) {
                if (sub.variantKey) {
                  const variant = product.variantStock[sub.variantKey];
                  if (variant && (variant.stock || 0) > 0) {
                    isInStock = true;
                    break;
                  }
                }
              }
              // If no specific variant, check total
              if (!subs.some((s: Record<string, unknown>) => s.variantKey)) {
                isInStock = (product.totalStock || product.stock || 0) > 0;
              }
            } else {
              isInStock = (product.totalStock || product.stock || 0) > 0;
            }
          }
        } else if (productType === 'vinyl') {
          const release = await getDocument('releases', productId);
          if (release) {
            productName = String(release.releaseName || release.name || productName);
            productUrl = `${SITE_URL}/item/${productId}`;
            isInStock = (release.vinylStock || 0) > 0;
          }
        }

        if (!isInStock) {
          results.stillOutOfStock++;
          continue;
        }

        // Product is back in stock - collect subscriptions for batch sending
        for (const sub of subs) {
          if (pendingEmails.length >= MAX_NOTIFICATIONS_PER_RUN) break;
          pendingEmails.push({ sub, productName, productUrl, productId });
        }

      } catch (productErr: unknown) {
        log.error('[Restock Notifications] Product lookup error:', productErr);
        results.errors++;
      }
    }

    // Phase 2: Send emails in parallel batches of EMAIL_BATCH_SIZE
    for (let i = 0; i < pendingEmails.length; i += EMAIL_BATCH_SIZE) {
      const batch = pendingEmails.slice(i, i + EMAIL_BATCH_SIZE);

      const batchResults = await Promise.allSettled(
        batch.map(async ({ sub, productName, productUrl, productId }) => {
          const email = String(sub.email || '');
          const variantKey = sub.variantKey ? String(sub.variantKey) : undefined;
          const html = buildRestockEmailHtml(productName, productUrl, variantKey, email, productId);

          const restockResp = await fetchWithTimeout('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${RESEND_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: 'Fresh Wax <shop@freshwax.co.uk>',
              to: [email],
              subject: `Back in Stock: ${productName}`,
              html
            })
          }, TIMEOUTS.API);

          if (!restockResp.ok) {
            log.error('[Restock Notifications] Email send failed', { status: restockResp.status, email });
            throw new Error(`Email send failed: ${restockResp.status}`);
          }

          // Remove subscription after successful send
          await deleteDocument('restockNotifications', sub.id as string);
          log.info('[Restock Notifications] Sent to', email, 'for', productName);
          return { email, productName };
        })
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.notified++;
        } else {
          log.error('[Restock Notifications] Email error:', result.reason);
          results.errors++;
        }
      }
    }

    const duration = Date.now() - startTime;
    log.info('[Restock Notifications] ========== COMPLETED ==========');
    log.info('[Restock Notifications] Duration:', duration, 'ms');
    log.info('[Restock Notifications] Results:', results);

    return successResponse({ duration,
      ...results });

  } catch (error: unknown) {
    log.error('[Restock Notifications] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
  } finally {
    if (db) await releaseCronLock(db, 'send-restock-notifications');
  }
};

export const GET: APIRoute = async (context) => POST(context);
