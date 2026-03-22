// src/lib/order/email-sender.ts
// Send all order-related emails (confirmation, stockist, digital artist, merch seller)
// Extracted from create-order.ts (pure extraction, zero behavior changes)

import { updateDocument } from '../firebase-rest';
import { fetchWithTimeout, createLogger, maskEmail } from '../api-utils';
import { buildOrderConfirmationEmail, buildStockistFulfillmentEmail, buildDigitalSaleEmail, buildMerchSaleEmail } from './create-order-emails';
import type { OrderItem } from './create-order-emails';

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

  // Send notification emails to artists for digital sales (tracks/releases)
  const digitalItems = order.items.filter((item: OrderItem) => item.type === 'track' || item.type === 'digital' || item.type === 'release');
  if (digitalItems.length > 0) {
    try {
      const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

      // Group items by artist email
      const itemsByArtist: { [email: string]: OrderItem[] } = {};
      for (const item of digitalItems) {
        const artistEmail = item.artistEmail;
        if (artistEmail) {
          if (!itemsByArtist[artistEmail]) {
            itemsByArtist[artistEmail] = [];
          }
          itemsByArtist[artistEmail].push(item);
        }
      }

      // Send email to each artist
      for (const [artistEmail, items] of Object.entries(itemsByArtist)) {
        if (RESEND_API_KEY && artistEmail) {
          log.info('[create-order] Sending digital sale email to artist:', maskEmail(artistEmail));

          const digitalHtml = buildDigitalSaleEmail(orderNumber, order, items);

          const digitalResponse = await fetchWithTimeout('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + RESEND_API_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: 'Fresh Wax <orders@freshwax.co.uk>',
              to: [artistEmail],
              bcc: ['freshwaxonline@gmail.com'],
              subject: '🎵 Digital Sale! ' + orderNumber,
              html: digitalHtml
            })
          }, 10000);

          if (digitalResponse.ok) {
            log.info('[create-order] ✓ Digital sale email sent to:', maskEmail(artistEmail));
          } else {
            const error = await digitalResponse.text();
            log.error('[create-order] ❌ Digital sale email failed:', error);
          }
        }
      }
    } catch (digitalError: unknown) {
      log.error('[create-order] Digital sale email error:', digitalError);
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
