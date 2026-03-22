// src/lib/order/create-order-emails.ts
// Email builder functions extracted from create-order.ts

import { escapeHtml } from '../escape-html';
import { SITE_URL } from '../constants';
import { formatPrice } from '../format-utils';

// Minimal type for order items flowing through the pipeline
export interface OrderItem {
  id?: string;
  productId?: string;
  releaseId?: string;
  trackId?: string;
  name: string;
  type?: string;
  price: number;
  quantity: number;
  size?: string;
  color?: string;
  image?: string;
  artwork?: string;
  artist?: string;
  artistId?: string;
  artistName?: string;
  artistEmail?: string;
  title?: string;
  isPreOrder?: boolean;
  releaseDate?: string;
  sellerId?: string;
  supplierId?: string;
  sellerEmail?: string;
  stockistEmail?: string;
  downloads?: { artworkUrl?: string; tracks?: { name: string; mp3Url?: string | null; wavUrl?: string | null }[] };
  [key: string]: unknown;
}

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

// Stockist/Label fulfillment email - sent when vinyl is ordered
export function buildStockistFulfillmentEmail(orderId: string, orderNumber: string, order: Record<string, unknown>, vinylItems: OrderItem[]): string {
  const orderDate = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  // Build vinyl items table
  let itemsHtml = '';
  for (const item of vinylItems) {
    itemsHtml += '<tr>' +
      '<td style="padding: 12px; border-bottom: 1px solid #e5e7eb; font-weight: 600;">' + escapeHtml(item.name) + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">' + (item.quantity || 1) + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">&pound;' + (item.price * (item.quantity || 1)).toFixed(2) + '</td>' +
      '</tr>';
  }

  // Calculate vinyl total
  const vinylTotal = vinylItems.reduce((sum: number, item: OrderItem) => sum + (item.price * (item.quantity || 1)), 0);

  // Payment status display
  const isTestMode = order.paymentMethod === 'test_mode';
  const paymentStatusColor = order.paymentStatus === 'completed' ? '#16a34a' : '#f59e0b';
  const paymentStatusText = order.paymentStatus === 'completed' ? 'PAID' : 'PENDING';
  const paymentMethodText = isTestMode ? 'Test Mode' : (order.paymentMethod === 'stripe' ? 'Stripe' : order.paymentMethod || 'Card');

  // Payment breakdown - fees are added on top, so artist gets their full asking price (subtotal)
  const artistPayment = order.totals.subtotal; // Artist gets their asking price
  const stripeFee = order.totals.stripeFee || 0;
  const freshWaxFee = order.totals.freshWaxFee || 0;
  const customerPaid = order.totals.total;

  // Payment confirmation section with breakdown
  const paymentSection = '<tr><td style="padding-bottom: 24px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: ' + (order.paymentStatus === 'completed' ? '#dcfce7' : '#fef3c7') + '; border: 2px solid ' + paymentStatusColor + '; border-radius: 8px;">' +
    '<tr><td style="padding: 16px;">' +
    '<div style="font-weight: 700; font-size: 12px; color: ' + paymentStatusColor + '; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">💳 Payment Confirmation</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding: 4px 0; color: #666; font-size: 13px;">Status:</td><td style="padding: 4px 0; font-weight: 700; color: ' + paymentStatusColor + '; font-size: 13px;">' + paymentStatusText + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #666; font-size: 13px;">Method:</td><td style="padding: 4px 0; font-weight: 600; color: #111; font-size: 13px;">' + paymentMethodText + '</td></tr>' +
    (order.stripePaymentId ? '<tr><td style="padding: 4px 0; color: #666; font-size: 13px;">Transaction ID:</td><td style="padding: 4px 0; font-family: monospace; color: #111; font-size: 12px;">' + order.stripePaymentId + '</td></tr>' : '') +
    '</table>' +

    // Payment breakdown - shows that artist gets their full asking price
    '<div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid ' + paymentStatusColor + ';">' +
    '<div style="font-weight: 700; font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Payment Breakdown</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding: 4px 0; color: #111; font-size: 14px; font-weight: 700;">Your Payment:</td><td style="padding: 4px 0; text-align: right; color: #16a34a; font-size: 14px; font-weight: 700;">' + formatPrice(artistPayment) + '</td></tr>' +
    '<tr><td colspan="2" style="padding: 4px 0 4px 0; border-top: 1px dashed #ccc;"></td></tr>' +
    '<tr><td style="padding: 4px 0; color: #9ca3af; font-size: 12px;">Stripe Fee (paid by customer):</td><td style="padding: 4px 0; text-align: right; color: #9ca3af; font-size: 12px;">' + formatPrice(stripeFee) + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #9ca3af; font-size: 12px;">Fresh Wax 1% (paid by customer):</td><td style="padding: 4px 0; text-align: right; color: #9ca3af; font-size: 12px;">' + formatPrice(freshWaxFee) + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #666; font-size: 13px;">Customer Paid:</td><td style="padding: 4px 0; text-align: right; color: #111; font-size: 13px;">' + formatPrice(customerPaid) + '</td></tr>' +
    '</table></div>' +

    (isTestMode ? '<div style="margin-top: 12px; padding: 8px; background: #fef3c7; border-radius: 4px; font-size: 12px; color: #92400e;">⚠️ This is a test order - no real payment was processed</div>' : '') +
    '</td></tr></table>' +
    '</td></tr>';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>' +
    '<body style="margin: 0; padding: 0; background: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #f3f4f6;"><tr><td align="center" style="padding: 40px 20px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px;">' +

    // Header - urgent red
    '<tr><td style="background: #dc2626; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">' +
    '<div style="font-size: 24px; font-weight: 800; color: #fff; letter-spacing: 1px;">📦 VINYL FULFILLMENT REQUIRED</div>' +
    '<div style="font-size: 14px; color: rgba(255,255,255,0.9); margin-top: 8px;">Fresh Wax Order</div>' +
    '</td></tr>' +

    // Main content
    '<tr><td style="background: #ffffff; padding: 32px; border-radius: 0 0 12px 12px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +

    // Payment confirmation - NEW SECTION
    paymentSection +

    // Order info box
    '<tr><td style="padding-bottom: 24px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #fef2f2; border: 2px solid #dc2626; border-radius: 8px;">' +
    '<tr><td style="padding: 16px;">' +
    '<div style="font-weight: 700; font-size: 12px; color: #991b1b; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Order Details</div>' +
    '<div style="font-size: 24px; font-weight: 800; color: #000; margin-bottom: 4px;">' + orderNumber + '</div>' +
    '<div style="font-size: 14px; color: #666;">' + orderDate + '</div>' +
    '</td></tr></table>' +
    '</td></tr>' +

    // Shipping address - IMPORTANT
    '<tr><td style="padding-bottom: 24px;">' +
    '<div style="font-weight: 700; font-size: 12px; color: #dc2626; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; border-bottom: 2px solid #dc2626; padding-bottom: 8px;">📍 Ship To</div>' +
    '<div style="font-size: 16px; line-height: 1.6; color: #111;">' +
    '<strong>' + escapeHtml(order.customer.firstName) + ' ' + escapeHtml(order.customer.lastName) + '</strong><br>' +
    escapeHtml(order.shipping?.address1 || '') + '<br>' +
    (order.shipping?.address2 ? escapeHtml(order.shipping.address2) + '<br>' : '') +
    escapeHtml(order.shipping?.city || '') + '<br>' +
    escapeHtml(order.shipping?.postcode || '') + '<br>' +
    (order.shipping?.county ? escapeHtml(order.shipping.county) + '<br>' : '') +
    escapeHtml(order.shipping?.country || 'United Kingdom') +
    '</div>' +
    (order.customer.phone ? '<div style="margin-top: 8px; font-size: 14px; color: #666;">📞 ' + escapeHtml(order.customer.phone) + '</div>' : '') +
    '</td></tr>' +

    // Items to fulfill
    '<tr><td style="padding-bottom: 24px;">' +
    '<div style="font-weight: 700; font-size: 12px; color: #000; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; border-bottom: 2px solid #000; padding-bottom: 8px;">Vinyl to Pack & Ship</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr style="background: #f9fafb;">' +
    '<th style="padding: 10px 12px; text-align: left; font-size: 12px; text-transform: uppercase; color: #666;">Release</th>' +
    '<th style="padding: 10px 12px; text-align: center; font-size: 12px; text-transform: uppercase; color: #666;">Qty</th>' +
    '<th style="padding: 10px 12px; text-align: right; font-size: 12px; text-transform: uppercase; color: #666;">Value</th>' +
    '</tr>' +
    itemsHtml +
    '<tr style="background: #000;">' +
    '<td colspan="2" style="padding: 12px; color: #fff; font-weight: 700;">Total Vinyl Value</td>' +
    '<td style="padding: 12px; color: #fff; font-weight: 700; text-align: right;">' + formatPrice(vinylTotal) + '</td>' +
    '</tr>' +
    '</table>' +
    '</td></tr>' +

    // Customer email for reference
    '<tr><td style="padding: 16px; background: #f9fafb; border-radius: 8px;">' +
    '<div style="font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Customer Email</div>' +
    '<div style="font-size: 14px; color: #111;">' + escapeHtml(order.customer.email) + '</div>' +
    '</td></tr>' +

    // Instructions
    '<tr><td style="padding-top: 24px;">' +
    '<div style="padding: 16px; background: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 0 8px 8px 0;">' +
    '<div style="font-weight: 700; color: #92400e; margin-bottom: 4px;">⚠️ Action Required</div>' +
    '<div style="font-size: 14px; color: #78350f; line-height: 1.5;">Please package and dispatch this order as soon as possible. Once shipped, please send tracking information to <a href="mailto:orders@freshwax.co.uk" style="color: #92400e;">orders@freshwax.co.uk</a></div>' +
    '</div>' +
    '</td></tr>' +

    '</table></td></tr>' +

    // Footer
    '<tr><td align="center" style="padding: 24px 0;">' +
    '<div style="color: #6b7280; font-size: 13px;">This is an automated fulfillment request from Fresh Wax</div>' +
    `<div style="margin-top: 8px;"><a href="${SITE_URL}" style="color: #dc2626; font-size: 12px; text-decoration: none; font-weight: 600;">freshwax.co.uk</a></div>` +
    '</td></tr>' +

    '</table></td></tr></table></body></html>';
}

// Build artist notification email for digital sales (tracks/releases)
export function buildDigitalSaleEmail(orderNumber: string, order: Record<string, unknown>, digitalItems: OrderItem[]): string {
  const digitalTotal = digitalItems.reduce((sum: number, item: OrderItem) => sum + (item.price * item.quantity), 0);

  // Calculate fees - use passed values or calculate from subtotal
  const subtotal = order.totals?.subtotal || digitalTotal;
  const freshWaxFee = order.totals?.freshWaxFee || (subtotal * 0.01);
  const baseAmount = subtotal + (order.totals?.shipping || 0) + freshWaxFee;
  const stripeFee = order.totals?.stripeFee || (((baseAmount * 0.014) + 0.20) / 0.986);
  const customerPaid = order.totals?.total || (subtotal + freshWaxFee + stripeFee);

  let itemsHtml = '';
  for (const item of digitalItems) {
    const typeLabel = item.type === 'track' ? 'Single Track' : 'Digital Release';
    itemsHtml += '<tr>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; color: #fff;">' + escapeHtml(item.name) + '<br><span style="font-size: 12px; color: #d1d5db;">' + typeLabel + '</span></td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; text-align: center; color: #fff;">' + item.quantity + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #374151; text-align: right; font-weight: 600; color: #fff;">&pound;' + (item.price * item.quantity).toFixed(2) + '</td>' +
      '</tr>';
  }

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
    '<div style="font-size: 22px; font-weight: 800; color: #fff; letter-spacing: 1px;">🎵 DIGITAL SALE!</div>' +
    '<div style="font-size: 14px; color: rgba(255,255,255,0.9); margin-top: 6px;">Order ' + orderNumber + '</div>' +
    '</td></tr>' +

    // Content
    '<tr><td style="background: #111; padding: 24px; border-left: 2px solid #dc2626; border-right: 2px solid #dc2626; border-bottom: 2px solid #dc2626; border-radius: 0 0 12px 12px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +

    // Success message
    '<tr><td style="padding-bottom: 20px; text-align: center;">' +
    '<div style="font-size: 18px; font-weight: 700; color: #16a34a;">Someone bought your music!</div>' +
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
    '<td style="padding: 12px; color: #fff; font-weight: 700; text-align: right;">' + formatPrice(digitalTotal) + '</td>' +
    '</tr>' +
    '</table>' +
    '</td></tr>' +

    // Payment breakdown
    '<tr><td style="padding-top: 20px;">' +
    '<div style="padding: 16px; background: #1f2937; border-radius: 8px; border: 1px solid #374151;">' +
    '<div style="font-weight: 700; font-size: 12px; color: #d1d5db; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">Payment Breakdown</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding: 6px 0; color: #16a34a; font-size: 15px; font-weight: 700;">Your Payment:</td><td style="padding: 6px 0; text-align: right; color: #16a34a; font-size: 15px; font-weight: 700;">' + formatPrice(digitalTotal) + '</td></tr>' +
    '<tr><td colspan="2" style="padding: 8px 0; border-top: 1px dashed #374151;"></td></tr>' +
    '<tr><td style="padding: 4px 0; color: #d1d5db; font-size: 13px;">Processing Fee (paid by customer):</td><td style="padding: 4px 0; text-align: right; color: #d1d5db; font-size: 13px;">' + formatPrice(stripeFee) + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #d1d5db; font-size: 13px;"><span style="color: #fff;">Fresh</span> <span style="color: #dc2626;">Wax</span> Tax (paid by customer):</td><td style="padding: 4px 0; text-align: right; color: #d1d5db; font-size: 13px;">' + formatPrice(freshWaxFee) + '</td></tr>' +
    '<tr><td colspan="2" style="padding: 8px 0; border-top: 1px dashed #374151;"></td></tr>' +
    '<tr><td style="padding: 6px 0; color: #fff; font-size: 15px; font-weight: 700;">Customer Paid:</td><td style="padding: 6px 0; text-align: right; color: #fff; font-size: 15px; font-weight: 700;">' + formatPrice(customerPaid) + '</td></tr>' +
    '</table>' +
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
