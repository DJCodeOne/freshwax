// Send the REAL vinyl fulfillment email for order FW-260611-HPZI5X to Hangry
// Records. The order was created by the verify-session fallback bug so the
// fulfillment email never fired; this sends it retroactively using the same
// template as src/lib/order/emails/vinyl-email.ts.
const fs = require('node:fs');
const path = require('node:path');
function loadEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('='); if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv();
const RESEND_API_KEY = process.env.RESEND_API_KEY;
if (!RESEND_API_KEY) { console.error('RESEND_API_KEY missing'); process.exit(1); }

const APPLY = process.argv.includes('--apply');
const RECIPIENT = 'hangryrecords@gmail.com';
const SITE_URL = 'https://freshwax.co.uk';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatPrice(amount) { return '£' + Number(amount).toFixed(2); }

const order = {
  paymentMethod: 'stripe',
  paymentStatus: 'completed',
  stripePaymentId: 'pi_3ThILTIDZxi2HzfN1S6UFHeg',
  customer: { firstName: 'Dave', lastName: 'Hagon', email: 'davidhagon@gmail.com', phone: '07971331814' },
  shipping: { address1: '38 Hilldene Avenue', address2: '', city: 'Romford', postcode: 'RM3 8YP', county: 'Essex', country: 'United Kingdom' },
  totals: { subtotal: 15, shipping: 4.99, stripeFee: 0.41, freshWaxFee: 0.15, total: 19.99 },
};
const orderNumber = 'FW-260611-HPZI5X';
const orderId = 'udSgfneZT3RUUrycCjif';
const orderDateStr = new Date('2026-06-11T23:49:32.091Z').toLocaleDateString('en-GB', {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
});
const vinylItems = [
  { name: 'Various Artists - Jungle & DnB Volume.1 (Part 1)', quantity: 1, price: 15 },
];

function buildStockistFulfillmentEmail(orderId, orderNumber, order, vinylItems) {
  const orderDate = orderDateStr;
  let itemsHtml = '';
  for (const item of vinylItems) {
    itemsHtml +=
      '<tr>' +
      '<td style="padding: 12px; border-bottom: 1px solid #e5e7eb; font-weight: 600;">' + escapeHtml(item.name) + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">' + (item.quantity || 1) + '</td>' +
      '<td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">&pound;' + (item.price * (item.quantity || 1)).toFixed(2) + '</td>' +
      '</tr>';
  }
  const vinylTotal = vinylItems.reduce((sum, item) => sum + (item.price * (item.quantity || 1)), 0);

  const paymentStatusColor = '#16a34a';
  const paymentStatusText = 'PAID';
  const paymentMethodText = 'Stripe';

  const vinylRevenue = order.totals.subtotal;
  const shippingPassThrough = order.totals.shipping || 0;
  const stripeFee = order.totals.stripeFee || 0;
  const freshWaxFee = order.totals.freshWaxFee || 0;
  const artistPayment = vinylRevenue + shippingPassThrough - stripeFee - freshWaxFee;
  const customerPaid = order.totals.total;

  const paymentSection =
    '<tr><td style="padding-bottom: 24px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #dcfce7; border: 2px solid ' + paymentStatusColor + '; border-radius: 8px;">' +
    '<tr><td style="padding: 16px;">' +
    '<div style="font-weight: 700; font-size: 12px; color: ' + paymentStatusColor + '; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">💳 Payment Confirmation</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding: 4px 0; color: #666; font-size: 13px;">Status:</td><td style="padding: 4px 0; font-weight: 700; color: ' + paymentStatusColor + '; font-size: 13px;">' + paymentStatusText + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #666; font-size: 13px;">Method:</td><td style="padding: 4px 0; font-weight: 600; color: #111; font-size: 13px;">' + paymentMethodText + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #666; font-size: 13px;">Transaction ID:</td><td style="padding: 4px 0; font-family: monospace; color: #111; font-size: 12px;">' + order.stripePaymentId + '</td></tr>' +
    '</table>' +
    '<div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid ' + paymentStatusColor + ';">' +
    '<div style="font-weight: 700; font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Payment Breakdown</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    '<tr><td style="padding: 4px 0; color: #111; font-size: 13px;">Vinyl revenue (asking price):</td><td style="padding: 4px 0; text-align: right; color: #111; font-size: 13px;">' + formatPrice(vinylRevenue) + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #111; font-size: 13px;">Postage charged to customer:</td><td style="padding: 4px 0; text-align: right; color: #111; font-size: 13px;">' + formatPrice(shippingPassThrough) + '</td></tr>' +
    '<tr><td style="padding: 6px 0 4px 0; color: #111; font-size: 13px; border-top: 1px solid #d1d5db;">Subtotal received from customer:</td><td style="padding: 6px 0 4px 0; text-align: right; color: #111; font-size: 13px; border-top: 1px solid #d1d5db;">' + formatPrice(vinylRevenue + shippingPassThrough) + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #b91c1c; font-size: 12px;">Less: Stripe processing fee:</td><td style="padding: 4px 0; text-align: right; color: #b91c1c; font-size: 12px;">−' + formatPrice(stripeFee) + '</td></tr>' +
    '<tr><td style="padding: 4px 0; color: #b91c1c; font-size: 12px;">Less: Fresh Wax 1% fee:</td><td style="padding: 4px 0; text-align: right; color: #b91c1c; font-size: 12px;">−' + formatPrice(freshWaxFee) + '</td></tr>' +
    '<tr><td style="padding: 6px 0 4px 0; color: #16a34a; font-size: 14px; font-weight: 700; border-top: 1px solid ' + paymentStatusColor + ';">Your Payment (net):</td><td style="padding: 6px 0 4px 0; text-align: right; color: #16a34a; font-size: 14px; font-weight: 700; border-top: 1px solid ' + paymentStatusColor + ';">' + formatPrice(artistPayment) + '</td></tr>' +
    '<tr><td colspan="2" style="padding: 6px 0 0 0; color: #6b7280; font-size: 11px; font-style: italic;">(Postage of ' + formatPrice(shippingPassThrough) + ' is included to cover your actual shipping cost)</td></tr>' +
    '<tr><td colspan="2" style="padding: 8px 0 4px 0; border-top: 1px dashed #ccc;"></td></tr>' +
    '<tr><td style="padding: 4px 0; color: #666; font-size: 13px;">Customer Paid (vinyl + postage):</td><td style="padding: 4px 0; text-align: right; color: #111; font-size: 13px;">' + formatPrice(customerPaid) + '</td></tr>' +
    '</table></div>' +
    '</td></tr></table>' +
    '</td></tr>';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>' +
    '<body style="margin: 0; padding: 0; background: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #f3f4f6;"><tr><td align="center" style="padding: 40px 20px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px;">' +
    '<tr><td style="background: #dc2626; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">' +
    '<div style="font-size: 24px; font-weight: 800; color: #fff; letter-spacing: 1px;">📦 VINYL FULFILLMENT REQUIRED</div>' +
    '<div style="font-size: 14px; color: rgba(255,255,255,0.9); margin-top: 8px;">Fresh Wax Order</div>' +
    '</td></tr>' +
    '<tr><td style="background: #ffffff; padding: 32px; border-radius: 0 0 12px 12px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    paymentSection +
    '<tr><td style="padding-bottom: 24px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #fef2f2; border: 2px solid #dc2626; border-radius: 8px;">' +
    '<tr><td style="padding: 16px;">' +
    '<div style="font-weight: 700; font-size: 12px; color: #991b1b; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Order Details</div>' +
    '<div style="font-size: 24px; font-weight: 800; color: #000; margin-bottom: 4px;">' + orderNumber + '</div>' +
    '<div style="font-size: 14px; color: #666;">' + orderDate + '</div>' +
    '</td></tr></table>' +
    '</td></tr>' +
    '<tr><td style="padding-bottom: 24px;">' +
    '<div style="font-weight: 700; font-size: 12px; color: #dc2626; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; border-bottom: 2px solid #dc2626; padding-bottom: 8px;">📍 Ship To</div>' +
    '<div style="font-size: 16px; line-height: 1.6; color: #111;">' +
    '<strong>' + escapeHtml(order.customer.firstName) + ' ' + escapeHtml(order.customer.lastName) + '</strong><br>' +
    escapeHtml(order.shipping.address1) + '<br>' +
    escapeHtml(order.shipping.city) + '<br>' +
    escapeHtml(order.shipping.postcode) + '<br>' +
    escapeHtml(order.shipping.county) + '<br>' +
    escapeHtml(order.shipping.country) +
    '</div>' +
    '<div style="margin-top: 8px; font-size: 14px; color: #666;">📞 ' + escapeHtml(order.customer.phone) + '</div>' +
    '</td></tr>' +
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
    '<tr><td style="padding: 16px; background: #f9fafb; border-radius: 8px;">' +
    '<div style="font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Customer Email</div>' +
    '<div style="font-size: 14px; color: #111;">' + escapeHtml(order.customer.email) + '</div>' +
    '</td></tr>' +
    '<tr><td style="padding-top: 24px;">' +
    '<div style="padding: 16px; background: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 0 8px 8px 0;">' +
    '<div style="font-weight: 700; color: #92400e; margin-bottom: 4px;">⚠️ Action Required</div>' +
    '<div style="font-size: 14px; color: #78350f; line-height: 1.5;">Please package and dispatch this order as soon as possible. Once shipped, please mark it as shipped in your <a href="' + SITE_URL + '/pro/releases/orders/" style="color:#92400e;font-weight:700;">Fresh Wax artist dashboard</a> and add the tracking number — the buyer will be notified automatically.</div>' +
    '</div>' +
    '</td></tr>' +
    '</table></td></tr>' +
    '<tr><td align="center" style="padding: 24px 0;">' +
    '<div style="margin-top: 8px;"><a href="' + SITE_URL + '" style="color: #dc2626; font-size: 12px; text-decoration: none; font-weight: 600;">freshwax.co.uk</a></div>' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

(async () => {
  const html = buildStockistFulfillmentEmail(orderId, orderNumber, order, vinylItems);
  if (!APPLY) {
    fs.writeFileSync(path.resolve(__dirname, 'hpzi5x-fulfillment-preview.html'), html);
    console.log('DRY-RUN: wrote scripts/hpzi5x-fulfillment-preview.html — re-run with --apply to send to ' + RECIPIENT);
    return;
  }
  console.log(`Sending fulfillment email to ${RECIPIENT}...`);
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Fresh Wax Orders <orders@freshwax.co.uk>',
      to: [RECIPIENT],
      bcc: ['freshwaxonline@gmail.com'],
      subject: 'VINYL FULFILLMENT REQUIRED - ' + orderNumber,
      html,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('Resend failed:', r.status, JSON.stringify(j)); process.exit(1); }
  console.log('Sent. Resend id:', j.id || '(none)');
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
