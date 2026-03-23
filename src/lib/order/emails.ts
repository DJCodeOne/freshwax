// src/lib/order/emails.ts
// Order email sending — templates in email-templates.ts

import { formatPrice } from '../format-utils';
import { SITE_URL } from '../constants';
import { sendResendEmail } from '../email';
import { log } from './types';
import type { CartItem } from './types';
import { getShortOrderNumber } from './utils';
import {
  buildOrderConfirmationEmail,
  buildStockistFulfillmentEmail,
  buildDigitalSaleEmail,
  buildMerchSaleEmail,
} from './email-templates';

// Send order confirmation email
export async function sendOrderConfirmationEmail(
  order: Record<string, unknown>,
  orderId: string,
  orderNumber: string,
  env: Record<string, unknown>
): Promise<void> {
  const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

  if (!RESEND_API_KEY || !order.customer?.email) {
    log.warn('[sendEmail] Skipping email - no API key or no customer email');
    return;
  }

  try {
    const shortOrderNumber = getShortOrderNumber(orderNumber);
    const emailHtml = buildOrderConfirmationEmail(orderId, shortOrderNumber, order);

    const result = await sendResendEmail({
      apiKey: RESEND_API_KEY,
      from: 'Fresh Wax <orders@freshwax.co.uk>',
      to: [order.customer.email],
      bcc: ['freshwaxonline@gmail.com'],
      subject: 'Order Confirmed - ' + shortOrderNumber,
      html: emailHtml,
      template: 'order-confirmation',
      db: env?.DB,
    });

    if (result.success) {
      // Email sent successfully
    } else {
      log.error('[sendEmail] Email failed:', result.error);
    }
  } catch (emailError: unknown) {
    log.error('[sendEmail] ❌ Exception:', emailError);
  }
}

// Send vinyl fulfillment email to stockist
export async function sendVinylFulfillmentEmail(
  order: Record<string, unknown>,
  orderId: string,
  orderNumber: string,
  vinylItems: CartItem[],
  env: Record<string, unknown>
): Promise<void> {
  const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
  const STOCKIST_EMAIL = env?.VINYL_STOCKIST_EMAIL || import.meta.env.VINYL_STOCKIST_EMAIL || 'stockist@freshwax.co.uk';

  if (!RESEND_API_KEY || !STOCKIST_EMAIL) return;

  try {
    log.info('[order-utils] Sending vinyl fulfillment email to stockist:', STOCKIST_EMAIL);
    const fulfillmentHtml = buildStockistFulfillmentEmail(orderId, orderNumber, order, vinylItems);

    const result = await sendResendEmail({
      apiKey: RESEND_API_KEY,
      from: 'Fresh Wax Orders <orders@freshwax.co.uk>',
      to: [STOCKIST_EMAIL],
      bcc: ['freshwaxonline@gmail.com'],
      subject: 'VINYL FULFILLMENT REQUIRED - ' + orderNumber,
      html: fulfillmentHtml,
      template: 'vinyl-fulfillment',
      db: env?.DB,
    });

    if (result.success) {
      log.info('[order-utils] Stockist email sent!');
    } else {
      log.error('[order-utils] Stockist email failed:', result.error);
    }
  } catch (stockistError: unknown) {
    log.error('[order-utils] Stockist email error:', stockistError);
  }
}

// Send digital sale notification to artists
export async function sendDigitalSaleEmails(
  order: Record<string, unknown>,
  orderNumber: string,
  digitalItems: CartItem[],
  env: Record<string, unknown>
): Promise<void> {
  const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return;

  // Group items by artist email
  const itemsByArtist: { [email: string]: CartItem[] } = {};
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
    try {
      log.info('[order-utils] Sending digital sale email to artist:', artistEmail);
      const digitalHtml = buildDigitalSaleEmail(orderNumber, order, items);

      await sendResendEmail({
        apiKey: RESEND_API_KEY,
        from: 'Fresh Wax <orders@freshwax.co.uk>',
        to: [artistEmail],
        bcc: ['freshwaxonline@gmail.com'],
        subject: 'Digital Sale! ' + orderNumber,
        html: digitalHtml,
        template: 'digital-sale-artist',
        db: env?.DB,
      });
      log.info('[order-utils] Digital sale email sent to:', artistEmail);
    } catch (digitalError: unknown) {
      log.error('[order-utils] Digital sale email error:', digitalError);
    }
  }
}

// Send merch sale notification to sellers
export async function sendMerchSaleEmails(
  order: Record<string, unknown>,
  orderNumber: string,
  merchItems: CartItem[],
  env: Record<string, unknown>
): Promise<void> {
  const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return;

  // Group items by seller email
  const itemsBySeller: { [email: string]: CartItem[] } = {};
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
    try {
      log.info('[order-utils] Sending merch sale email to seller:', sellerEmail);
      const merchHtml = buildMerchSaleEmail(orderNumber, order, items);

      await sendResendEmail({
        apiKey: RESEND_API_KEY,
        from: 'Fresh Wax Orders <orders@freshwax.co.uk>',
        to: [sellerEmail],
        bcc: ['freshwaxonline@gmail.com'],
        subject: 'Merch Order! ' + orderNumber,
        html: merchHtml,
        template: 'merch-sale-seller',
        db: env?.DB,
      });
      log.info('[order-utils] Merch sale email sent to:', sellerEmail);
    } catch (merchError: unknown) {
      log.error('[order-utils] Merch sale email error:', merchError);
    }
  }
}
