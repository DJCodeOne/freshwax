// src/lib/order/emails/merch-email.ts
// Merch seller notification email — dark theme

import { escapeHtml } from '../../escape-html';
import { SITE_URL } from '../../constants';
import { formatPrice } from '../../format-utils';
import type { OrderItem } from './types';

// Build merch seller notification email
export function buildMerchSaleEmail(orderNumber: string, order: Record<string, unknown>, merchItems: OrderItem[]): string {
  const merchTotal = merchItems.reduce((sum: number, item: OrderItem) => sum + (item.price * item.quantity), 0);

  // Calculate fees - use passed values or calculate from subtotal
  const subtotal = order.totals?.subtotal || merchTotal;
  const freshWaxFee = order.totals?.freshWaxFee || (subtotal * 0.01);
  const baseAmount = subtotal + (order.totals?.shipping || 0) + freshWaxFee;
  const stripeFee = order.totals?.stripeFee || (((baseAmount * 0.014) + 0.20) / 0.986);
  const customerPaid = order.totals?.total || (subtotal + freshWaxFee + stripeFee);

  let itemsHtml = '';
  for (const item of merchItems) {
    const details = [item.size ? 'Size: ' + escapeHtml(item.size) : '', escapeHtml(item.color) || ''].filter(Boolean).join(' &bull; ');
    itemsHtml += '<tr>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; color: #fff;">' +
      (item.image ? '<img src="' + escapeHtml(item.image) + '" width="50" height="50" style="border-radius: 4px; margin-right: 10px; vertical-align: middle;">' : '') +
      escapeHtml(item.name) + (details ? '<br><span style="font-size: 12px; color: #d1d5db;">' + details + '</span>' : '') + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; text-align: center; color: #fff;">' + item.quantity + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; text-align: right; font-weight: 600; color: #fff;">&pound;' + (item.price * item.quantity).toFixed(2) + '</td>' +
      '</tr>';
  }

  // Note: Shipping handled by Fresh Wax - no address shown to sellers

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>' +
    '<body style="margin: 0; padding: 0; background: #000; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #000;"><tr><td align="center" style="padding: 40px 20px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px;">' +

    // Header - Fresh Wax branding
    '<tr><td style="background: #fff; padding: 32px 24px; border-radius: 12px 12px 0 0; text-align: center; border: 2px solid #dc2626; border-bottom: none;">' +
    `<img src="${SITE_URL}/logo.webp" alt="Fresh Wax" width="50" height="50" style="display: block; margin: 0 auto 12px; border-radius: 6px;">` +
    '<div style="font-size: 28px; font-weight: 800; letter-spacing: 1px;"><span style="color: #000;">FRESH</span> <span style="color: #dc2626;">WAX</span></div>' +
    '<div style="font-size: 12px; color: #666; margin-top: 4px; letter-spacing: 2px;">JUNGLE • DRUM AND BASS</div>' +
    '</td></tr>' +

    // Sale notification header
    '<tr><td style="background: #dc2626; padding: 20px 24px; text-align: center; border-left: 2px solid #dc2626; border-right: 2px solid #dc2626;">' +
    '<div style="font-size: 22px; font-weight: 800; color: #fff; letter-spacing: 1px;">👕 MERCH ORDER!</div>' +
    '<div style="font-size: 14px; color: rgba(255,255,255,0.9); margin-top: 6px;">Order ' + orderNumber + '</div>' +
    '</td></tr>' +

    // Content
    '<tr><td style="background: #111; padding: 24px; border-left: 2px solid #dc2626; border-right: 2px solid #dc2626; border-bottom: 2px solid #dc2626; border-radius: 0 0 12px 12px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +

    // Success message
    '<tr><td style="padding-bottom: 20px; text-align: center;">' +
    '<div style="font-size: 18px; font-weight: 700; color: #16a34a;">Someone bought your merch!</div>' +
    '<div style="font-size: 14px; color: #d1d5db; margin-top: 4px;">Customer: ' + escapeHtml(order.customer.firstName) + ' ' + escapeHtml(order.customer.lastName) + '</div>' +
    '</td></tr>' +

    // Items table
    '<tr><td>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border: 1px solid #374151; border-radius: 8px; overflow: hidden; background: #1f2937;">' +
    '<tr style="background: #374151;">' +
    '<th style="padding: 12px; text-align: left; font-size: 12px; color: #d1d5db; text-transform: uppercase;">Item</th>' +
    '<th style="padding: 12px; text-align: center; font-size: 12px; color: #d1d5db; text-transform: uppercase;">Qty</th>' +
    '<th style="padding: 12px; text-align: right; font-size: 12px; color: #d1d5db; text-transform: uppercase;">Price</th>' +
    '</tr>' +
    itemsHtml +
    '<tr style="background: #dc2626;">' +
    '<td colspan="2" style="padding: 12px; color: #fff; font-weight: 700;">Your Earnings</td>' +
    '<td style="padding: 12px; color: #fff; font-weight: 700; text-align: right;">' + formatPrice(merchTotal) + '</td>' +
    '</tr>' +
    '</table>' +
    '</td></tr>' +

    // Payment breakdown
    '<tr><td style="padding-top: 20px;">' +
    '<div style="padding: 16px; background: #1f2937; border-radius: 8px; border: 1px solid #374151;">' +
    '<div style="font-weight: 700; font-size: 12px; color: #d1d5db; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">Payment Breakdown</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding: 6px 0; color: #16a34a; font-size: 15px; font-weight: 700;">Your Payment:</td><td style="padding: 6px 0; text-align: right; color: #16a34a; font-size: 15px; font-weight: 700;">' + formatPrice(merchTotal) + '</td></tr>' +
    '<tr><td colspan="2" style="padding: 8px 0; border-top: 1px dashed #374151;"></td></tr>' +
    '<tr><td style="padding: 4px 0; color: #d1d5db; font-size: 13px;">Processing Fee (paid by customer):</td><td style="padding: 4px 0; text-align: right; color: #d1d5db; font-size: 13px;">' + formatPrice(stripeFee) + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #d1d5db; font-size: 13px;"><span style="color: #fff;">Fresh</span> <span style="color: #dc2626;">Wax</span> Tax (paid by customer):</td><td style="padding: 4px 0; text-align: right; color: #d1d5db; font-size: 13px;">' + formatPrice(freshWaxFee) + '</td></tr>' +
    '<tr><td colspan="2" style="padding: 8px 0; border-top: 1px dashed #374151;"></td></tr>' +
    '<tr><td style="padding: 6px 0; color: #fff; font-size: 15px; font-weight: 700;">Customer Paid:</td><td style="padding: 6px 0; text-align: right; color: #fff; font-size: 15px; font-weight: 700;">' + formatPrice(customerPaid) + '</td></tr>' +
    '</table>' +
    '</div>' +
    '</td></tr>' +

    // Info box - Fresh Wax handles shipping
    '<tr><td style="padding-top: 20px;">' +
    '<div style="padding: 16px; background: #1f2937; border-left: 4px solid #16a34a; border-radius: 0 8px 8px 0;">' +
    '<div style="font-weight: 700; color: #16a34a; margin-bottom: 4px;">✅ No Action Required</div>' +
    `<div style="font-size: 14px; color: #d1d5db; line-height: 1.5;">Fresh Wax handles all shipping and fulfilment. View your sales and earnings in your <a href="${SITE_URL}/artist/dashboard" style="color: #dc2626;">Artist Dashboard</a>.</div>` +
    '</div>' +
    '</td></tr>' +

    '</table></td></tr>' +

    // Footer
    '<tr><td align="center" style="padding: 24px 0;">' +
    '<div style="color: #d1d5db; font-size: 13px;">Automated notification from Fresh Wax</div>' +
    `<div style="margin-top: 8px;"><a href="${SITE_URL}" style="color: #dc2626; font-size: 12px; text-decoration: none; font-weight: 600;">freshwax.co.uk</a></div>` +
    '</td></tr>' +

    '</table></td></tr></table></body></html>';
}
