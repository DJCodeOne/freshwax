// src/lib/order/emails/buyer-email.ts
// Buyer order confirmation email builder — light theme

import { escapeHtml } from '../../escape-html';
import { SITE_URL } from '../../constants';
import { formatPrice } from '../../format-utils';

// Email template function - Light theme
export function buildOrderConfirmationEmail(orderId: string, orderNumber: string, order: Record<string, unknown>): string {
  const confirmationUrl = `${SITE_URL}/order-confirmation/${orderId}`;

  // Build items HTML - only show image for merch items
  let itemsHtml = '';
  for (const item of order.items) {
    // Check if this is a merch item (only merch gets images)
    const isMerchItem = item.type === 'merch';

    // Only use image for merch
    const itemImage = isMerchItem ? (item.image || item.artwork || '') : '';

    // Format the item type for display
    let typeLabel = '';
    if (item.type === 'digital') typeLabel = 'Digital Download';
    else if (item.type === 'track') typeLabel = 'Single Track';
    else if (item.type === 'vinyl') typeLabel = 'Vinyl Record';
    else if (item.type === 'merch') typeLabel = 'Merchandise';
    else typeLabel = escapeHtml(item.type) || '';

    // Only show image column for merch - centered
    const imageHtml = itemImage ? '<img src="' + escapeHtml(itemImage) + '" alt="' + escapeHtml(item.name) + '" width="70" height="70" style="border-radius: 8px; display: block; margin: 0 auto;">' : '';

    itemsHtml += '<tr><td style="padding: 16px 0; border-bottom: 1px solid #e5e7eb;">' +
      '<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
      (itemImage ? '<td width="86" style="padding-right: 16px; vertical-align: middle; text-align: center;">' + imageHtml + '</td>' : '') +
      '<td style="vertical-align: middle; text-align: left;">' +
      '<div style="font-weight: 600; color: #111; font-size: 15px; margin-bottom: 4px; text-align: left;">' + escapeHtml(item.name) + '</div>' +
      '<div style="font-size: 13px; color: #6b7280; text-align: left;">' +
      typeLabel +
      (item.size ? ' &bull; Size: ' + escapeHtml(item.size) : '') +
      (item.color ? ' &bull; ' + escapeHtml(item.color) : '') +
      (item.quantity > 1 ? ' &bull; Qty: ' + item.quantity : '') +
      '</div></td>' +
      '<td width="80" style="text-align: right; font-weight: 600; color: #111; vertical-align: middle;">&pound;' + (item.price * item.quantity).toFixed(2) + '</td>' +
      '</tr></table></td></tr>';
  }

  // Shipping section
  const shippingSection = order.shipping ?
    '<tr><td style="padding: 20px 24px; background: #f9fafb; border-radius: 8px; margin-top: 16px;">' +
    '<div style="font-weight: 700; color: #111; margin-bottom: 10px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">Shipping To</div>' +
    '<div style="color: #374151; line-height: 1.6; font-size: 14px;">' +
    escapeHtml(order.customer.firstName) + ' ' + escapeHtml(order.customer.lastName) + '<br>' +
    escapeHtml(order.shipping.address1) + '<br>' +
    (order.shipping.address2 ? escapeHtml(order.shipping.address2) + '<br>' : '') +
    escapeHtml(order.shipping.city) + ', ' + escapeHtml(order.shipping.postcode) + '<br>' +
    (order.shipping.county ? escapeHtml(order.shipping.county) + '<br>' : '') +
    escapeHtml(order.shipping.country) +
    '</div></td></tr><tr><td style="height: 16px;"></td></tr>' : '';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Order Confirmation</title></head>' +
    '<body style="margin: 0; padding: 0; background: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #f3f4f6;"><tr><td align="center" style="padding: 40px 20px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px;">' +

    // Header with logo and brand - BLACK background
    '<tr><td style="background: #000000; padding: 32px 24px; border-radius: 12px 12px 0 0; text-align: center;">' +
    `<img src="${SITE_URL}/logo.webp" alt="Fresh Wax" width="60" height="60" style="display: block; margin: 0 auto 12px; border-radius: 8px;">` +
    '<div style="font-size: 28px; font-weight: 800; letter-spacing: 1px;"><span style="color: #ffffff;">FRESH</span> <span style="color: #dc2626;">WAX</span></div>' +
    '<div style="font-size: 12px; color: #d1d5db; margin-top: 4px; letter-spacing: 2px;">JUNGLE • DRUM AND BASS</div>' +
    '</td></tr>' +

    // Main content card
    '<tr><td style="background: #ffffff; padding: 32px 24px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +

    // Success message
    '<tr><td align="center" style="padding-bottom: 24px;">' +
    '<div style="width: 56px; height: 56px; background: #dcfce7; border-radius: 50%; margin: 0 auto 16px; line-height: 56px; text-align: center;">' +
    '<span style="color: #16a34a; font-size: 28px;">✓</span></div>' +
    '<h1 style="margin: 0; color: #111; font-size: 24px; font-weight: 700;">Order Confirmed!</h1>' +
    '<p style="margin: 8px 0 0; color: #6b7280; font-size: 14px;">Thank you for your purchase</p>' +
    '</td></tr>' +

    // Order number
    '<tr><td align="center" style="padding-bottom: 24px;">' +
    '<div style="display: inline-block; background: #f3f4f6; padding: 12px 24px; border-radius: 8px;">' +
    '<div style="color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Order Number</div>' +
    '<div style="color: #dc2626; font-size: 18px; font-weight: 700; margin-top: 4px;">' + orderNumber + '</div>' +
    '</div></td></tr>' +

    // Divider
    '<tr><td style="border-top: 1px solid #e5e7eb; padding-top: 24px;"></td></tr>' +

    // Items header - green with dividing line
    '<tr><td style="padding-bottom: 12px; border-bottom: 1px solid #e5e7eb;">' +
    '<div style="font-weight: 700; color: #16a34a; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">Order Details</div>' +
    '</td></tr>' +

    // Items list
    '<tr><td><table cellpadding="0" cellspacing="0" border="0" width="100%">' + itemsHtml + '</table></td></tr>' +

    // Totals - red dividing line above
    '<tr><td style="padding-top: 16px; border-top: 2px solid #dc2626;"><table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="color: #6b7280; padding: 8px 0; font-size: 14px;">Subtotal</td><td style="color: #111; text-align: right; padding: 8px 0; font-size: 14px;">' + formatPrice(order.totals.subtotal) + '</td></tr>' +
    '<tr><td style="color: #6b7280; padding: 8px 0; font-size: 14px;">Shipping</td><td style="color: #111; text-align: right; padding: 8px 0; font-size: 14px;">' +
    (order.hasPhysicalItems ? (order.totals.shipping === 0 ? 'FREE' : formatPrice(order.totals.shipping)) : 'Digital delivery') + '</td></tr>' +
    (order.totals.serviceFees ? '<tr><td style="color: #9ca3af; padding: 8px 0; font-size: 13px;">Service Fee</td><td style="color: #9ca3af; text-align: right; padding: 8px 0; font-size: 13px;">' + formatPrice(order.totals.serviceFees) + '</td></tr>' : '') +
    '<tr><td colspan="2" style="border-top: 2px solid #dc2626; padding-top: 12px;"></td></tr>' +
    '<tr><td style="color: #111; font-weight: 700; font-size: 16px; padding: 4px 0;">Total</td>' +
    '<td style="color: #dc2626; font-weight: 700; font-size: 20px; text-align: right; padding: 4px 0;">' + formatPrice(order.totals.total) + '</td></tr>' +
    '</table></td></tr>' +

    // Spacing
    '<tr><td style="height: 24px;"></td></tr>' +

    // Shipping address (if applicable)
    shippingSection +

    // Go back to store button
    '<tr><td align="center" style="padding: 24px 0 8px;">' +
    `<a href="${SITE_URL}" style="display: inline-block; padding: 14px 32px; background: #000000; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">Go Back to Store</a>` +
    '</td></tr>' +

    '</table></td></tr>' +

    // Footer
    '<tr><td align="center" style="padding: 24px 0;">' +
    '<div style="color: #6b7280; font-size: 13px; line-height: 1.6;">Question? Email us at <a href="mailto:contact@freshwax.co.uk" style="color: #111; text-decoration: underline;">contact@freshwax.co.uk</a></div>' +
    `<div style="margin-top: 12px;"><a href="${SITE_URL}" style="color: #9ca3af; font-size: 12px; text-decoration: none;">freshwax.co.uk</a></div>` +
    '</td></tr>' +

    '</table></td></tr></table></body></html>';
}
