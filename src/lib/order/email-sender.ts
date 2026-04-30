// src/lib/order/email-sender.ts
// Send all order-related emails (confirmation, stockist, digital artist, merch seller)
// Extracted from create-order.ts (pure extraction, zero behavior changes)

import { updateDocument, getDocument } from '../firebase-rest';
import { fetchWithTimeout, createLogger, maskEmail } from '../api-utils';
import { buildOrderConfirmationEmail, buildStockistFulfillmentEmail, buildDigitalSaleEmail, buildMerchSaleEmail } from './create-order-emails';
import type { OrderItem } from './create-order-emails';
import { emailWrapper, ctaButton, esc } from '../email-wrapper';
import { SITE_URL } from '../constants';

const log = createLogger('create-order');

interface SendOrderEmailsParams {
  order: Record<string, unknown>;
  orderRefId: string;
  orderNumber: string;
  env: Record<string, unknown>;
}

/**
 * Send all order-related emails: confirmation to buyer, fulfillment to stockist,
 * digital sale notifications to artists, merch sale notifications to sellers.
 * Also marks vinyl crates listings as sold.
 * Errors are logged but never fail the order.
 */
export async function sendOrderEmails({ order, orderRefId, orderNumber, env }: SendOrderEmailsParams): Promise<void> {
  // Send confirmation email directly
  try {
    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (RESEND_API_KEY && order.customer?.email) {
      log.info('[create-order] Sending email to:', maskEmail(order.customer.email));

      // Extract short order number for customer display (e.g., "FW-ABC123" from "FW-241204-abc123")
      const orderParts = orderNumber.split('-');
      const shortOrderNumber = orderParts.length >= 3
        ? (orderParts[0] + '-' + orderParts[orderParts.length - 1]).toUpperCase()
        : orderNumber.toUpperCase();

      const emailHtml = buildOrderConfirmationEmail(orderRefId, shortOrderNumber, order);

      const emailResponse = await fetchWithTimeout('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + RESEND_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Fresh Wax <orders@freshwax.co.uk>',
          to: [order.customer.email],
          bcc: ['freshwaxonline@gmail.com'],
          subject: 'Order Confirmed - ' + shortOrderNumber,
          html: emailHtml
        })
      }, 10000);

      if (emailResponse.ok) {
        const emailResult = await emailResponse.json();
        log.info('[create-order] ✓ Email sent! ID:', emailResult.id);
      } else {
        const error = await emailResponse.text();
        log.error('[create-order] ❌ Email failed:', error);
      }
    } else {
      log.info('[create-order] Skipping email - no API key or no customer email');
    }
  } catch (emailError: unknown) {
    log.error('[create-order] Email error:', emailError);
    // Don't fail the order if email fails
  }

  // Send fulfillment email to stockist/label for vinyl orders
  const vinylItems = order.items.filter((item: OrderItem) => item.type === 'vinyl');
  if (vinylItems.length > 0) {
    try {
      const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
      const STOCKIST_EMAIL = env?.VINYL_STOCKIST_EMAIL || import.meta.env.VINYL_STOCKIST_EMAIL || 'stockist@freshwax.co.uk';

      if (RESEND_API_KEY && STOCKIST_EMAIL) {
        log.info('[create-order] Sending vinyl fulfillment email to stockist:', STOCKIST_EMAIL);

        const fulfillmentHtml = buildStockistFulfillmentEmail(orderRefId, orderNumber, order, vinylItems);

        const fulfillmentResponse = await fetchWithTimeout('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + RESEND_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Fresh Wax Orders <orders@freshwax.co.uk>',
            to: [STOCKIST_EMAIL],
            bcc: ['freshwaxonline@gmail.com'],
            subject: '📦 VINYL FULFILLMENT REQUIRED - ' + orderNumber,
            html: fulfillmentHtml
          })
        }, 10000);

        if (fulfillmentResponse.ok) {
          const result = await fulfillmentResponse.json();
          log.info('[create-order] ✓ Stockist email sent! ID:', result.id);
        } else {
          const error = await fulfillmentResponse.text();
          log.error('[create-order] ❌ Stockist email failed:', error);
        }
      }
    } catch (stockistError: unknown) {
      log.error('[create-order] Stockist email error:', stockistError);
      // Don't fail the order if stockist email fails
    }

    // Mark vinyl crates listings as sold (single-item listings from marketplace sellers)
    for (const vItem of vinylItems) {
      if (vItem.sellerId && !vItem.releaseId) {
        const listingId = vItem.id || vItem.productId;
        if (listingId) {
          try {
            await updateDocument('vinylListings', listingId, {
              status: 'sold',
              soldAt: new Date().toISOString(),
              orderId: orderRefId,
              orderNumber
            });
            log.info('[create-order] Marked vinyl listing as sold:', listingId);
          } catch (vinylErr: unknown) {
            log.error('[create-order] Failed to mark vinyl as sold:', listingId, vinylErr);
          }
        }
      }
    }
  }

  // Send notification emails to digital payees (artists / labels).
  // Resolved using the same logic as processArtistPayments so we always
  // notify everyone who'll get money from the order:
  //   - For releases with a `payoutSplits` array, every recipient.
  //   - Otherwise, the release.artistId account.
  // The buyer's items are not enumerated in the email — payees check their
  // dashboard for the breakdown. Keeps emails simple + privacy-safe.
  const digitalItems = order.items.filter((item: OrderItem) => item.type === 'track' || item.type === 'digital' || item.type === 'release');
  if (digitalItems.length > 0) {
    const RESEND_API_KEY = (env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY) as string | undefined;
    if (RESEND_API_KEY) {
      try {
        // Resolve unique payee artistIds, batching release fetches.
        const releaseIds = new Set<string>();
        for (const item of digitalItems) {
          const releaseId = (item.releaseId || item.productId || item.id) as string | undefined;
          if (releaseId) releaseIds.add(releaseId);
        }
        const releaseEntries = await Promise.all(
          [...releaseIds].map(async (id) => [id, await getDocument('releases', id).catch(() => null)] as const)
        );
        const releaseMap = new Map(releaseEntries.filter(([, doc]) => doc));

        const payeeIds = new Set<string>();
        for (const item of digitalItems) {
          const releaseId = (item.releaseId || item.productId || item.id) as string | undefined;
          if (!releaseId) continue;
          const release = releaseMap.get(releaseId) as Record<string, unknown> | undefined;
          if (!release) continue;
          const splits = (release.payoutSplits as Array<{ artistId?: unknown; percentage?: unknown }> | undefined);
          if (Array.isArray(splits) && splits.length > 0) {
            for (const s of splits) {
              if (typeof s.artistId === 'string' && typeof s.percentage === 'number' && s.percentage > 0) {
                payeeIds.add(s.artistId);
              }
            }
          } else {
            const aid = (item.artistId || (release as { artistId?: string; userId?: string }).artistId || (release as { artistId?: string; userId?: string }).userId) as string | undefined;
            if (aid) payeeIds.add(aid);
          }
        }

        // Fetch each payee's account doc for email + display name.
        const payeeEntries = await Promise.all(
          [...payeeIds].map(async (id) => {
            const [artistDoc, userDoc] = await Promise.all([
              getDocument('artists', id).catch(() => null),
              getDocument('users', id).catch(() => null),
            ]);
            const email = (artistDoc?.email || userDoc?.email) as string | undefined;
            const name = (artistDoc?.artistName || artistDoc?.displayName || userDoc?.displayName || userDoc?.name || 'Artist') as string;
            return { id, email, name };
          })
        );

        // Send one short email per unique email address (a single account
        // could appear under multiple ids in unusual edge cases; dedupe).
        const sentTo = new Set<string>();
        for (const payee of payeeEntries) {
          if (!payee.email || sentTo.has(payee.email)) continue;
          sentTo.add(payee.email);

          log.info('[create-order] Sending payee sale notification to:', maskEmail(payee.email));

          const html = emailWrapper(`
            <p style="font-size:18px;line-height:1.5;margin:0 0 16px;">
              Hey ${esc(payee.name)} 👋
            </p>
            <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">
              You've got a new sale on Fresh Wax. Someone just bought your music.
            </p>
            <p style="font-size:14px;line-height:1.5;color:#999;margin:0 0 24px;">
              Order: <strong>${esc(orderNumber)}</strong>
            </p>
            ${ctaButton('View your dashboard', SITE_URL + '/account/dashboard/')}
            <p style="font-size:13px;line-height:1.5;color:#999;margin:24px 0 0;">
              Your dashboard shows the breakdown of which tracks/releases sold and what your share is. Payouts are processed manually — we'll be in touch.
            </p>
          `, { title: 'New Sale on Fresh Wax', preheader: 'You have a new order on Fresh Wax' });

          const response = await fetchWithTimeout('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'Fresh Wax <orders@freshwax.co.uk>',
              to: [payee.email],
              bcc: ['freshwaxonline@gmail.com'],
              subject: '🎵 You have a new sale on Fresh Wax',
              html,
            }),
          }, 10000);

          if (response.ok) {
            log.info('[create-order] ✓ Payee notification sent to:', maskEmail(payee.email));
          } else {
            const error = await response.text();
            log.error('[create-order] ❌ Payee notification failed:', error);
          }
        }

        if (sentTo.size === 0 && digitalItems.length > 0) {
          log.warn('[create-order] No payee emails resolved for digital items in order:', orderNumber);
        }
      } catch (payeeErr: unknown) {
        log.error('[create-order] Payee notification error:', payeeErr);
      }
    }
  }

  // Send notification emails to merch sellers
  const merchItems = order.items.filter((item: OrderItem) => item.type === 'merch');
  if (merchItems.length > 0) {
    try {
      const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

      // Group items by seller email (use stockistEmail or artistEmail)
      const itemsBySeller: { [email: string]: OrderItem[] } = {};
      for (const item of merchItems) {
        const sellerEmail = item.stockistEmail || item.artistEmail || item.sellerEmail;
        if (sellerEmail) {
          if (!itemsBySeller[sellerEmail]) {
            itemsBySeller[sellerEmail] = [];
          }
          itemsBySeller[sellerEmail].push(item);
        }
      }

      // Send email to each seller
      for (const [sellerEmail, items] of Object.entries(itemsBySeller)) {
        if (RESEND_API_KEY && sellerEmail) {
          log.info('[create-order] Sending merch sale email to seller:', maskEmail(sellerEmail));

          const merchHtml = buildMerchSaleEmail(orderNumber, order, items);

          const merchResponse = await fetchWithTimeout('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + RESEND_API_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: 'Fresh Wax Orders <orders@freshwax.co.uk>',
              to: [sellerEmail],
              bcc: ['freshwaxonline@gmail.com'],
              subject: '👕 Merch Order! ' + orderNumber,
              html: merchHtml
            })
          }, 10000);

          if (merchResponse.ok) {
            log.info('[create-order] ✓ Merch sale email sent to:', maskEmail(sellerEmail));
          } else {
            const error = await merchResponse.text();
            log.error('[create-order] ❌ Merch sale email failed:', error);
          }
        }
      }
    } catch (merchError: unknown) {
      log.error('[create-order] Merch sale email error:', merchError);
    }
  }
}
