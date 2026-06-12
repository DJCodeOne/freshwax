// Follow-up to the FW-260611-HPZI5X fulfillment email: corrected net payment
// figure (£19.43 estimate -> £19.26 actual Stripe fee).
// Default recipient is the preview address; pass --to-hangry to send the
// real one to hangryrecords@gmail.com.
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

const TO_HANGRY = process.argv.includes('--to-hangry');
const RECIPIENT = TO_HANGRY ? 'hangryrecords@gmail.com' : 'davidhagon@gmail.com';
const SITE_URL = 'https://freshwax.co.uk';
const orderNumber = 'FW-260611-HPZI5X';

function formatPrice(a) { return '£' + Number(a).toFixed(2); }

const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>' +
  '<body style="margin: 0; padding: 0; background: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">' +
  '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #f3f4f6;"><tr><td align="center" style="padding: 40px 20px;">' +
  '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px;">' +

  '<tr><td style="background: #000000; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">' +
  '<div style="font-size: 20px; font-weight: 800; color: #fff; letter-spacing: 1px;">PAYMENT FIGURE CORRECTION</div>' +
  '<div style="font-size: 14px; color: rgba(255,255,255,0.85); margin-top: 8px;">Order ' + orderNumber + '</div>' +
  '</td></tr>' +

  '<tr><td style="background: #ffffff; padding: 32px; border-radius: 0 0 12px 12px;">' +

  '<p style="font-size: 15px; color: #111; line-height: 1.6; margin: 0 0 16px 0;">Hi Hangry Records,</p>' +
  '<p style="font-size: 15px; color: #111; line-height: 1.6; margin: 0 0 16px 0;">A quick correction to the fulfillment email we sent for order <strong>' + orderNumber + '</strong>. The payment breakdown quoted an <em>estimated</em> Stripe processing fee — we now have the actual fee from Stripe, so your net payment is slightly different:</p>' +

  '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 16px;">' +
  '<tr><td style="padding: 16px;">' +
  '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
  '<tr><td style="padding: 4px 0; color: #111; font-size: 13px;">Vinyl revenue (asking price):</td><td style="padding: 4px 0; text-align: right; color: #111; font-size: 13px;">' + formatPrice(15) + '</td></tr>' +
  '<tr><td style="padding: 4px 0; color: #111; font-size: 13px;">Postage charged to customer (100% to you):</td><td style="padding: 4px 0; text-align: right; color: #111; font-size: 13px;">' + formatPrice(4.99) + '</td></tr>' +
  '<tr><td style="padding: 4px 0; color: #b91c1c; font-size: 12px;">Less: Stripe processing fee (actual):</td><td style="padding: 4px 0; text-align: right; color: #b91c1c; font-size: 12px;">−' + formatPrice(0.58) + '</td></tr>' +
  '<tr><td style="padding: 4px 0; color: #b91c1c; font-size: 12px;">Less: Fresh Wax 1% fee:</td><td style="padding: 4px 0; text-align: right; color: #b91c1c; font-size: 12px;">−' + formatPrice(0.15) + '</td></tr>' +
  '<tr><td style="padding: 8px 0 4px 0; color: #16a34a; font-size: 15px; font-weight: 700; border-top: 1px solid #d1d5db;">Your Payment (net):</td><td style="padding: 8px 0 4px 0; text-align: right; color: #16a34a; font-size: 15px; font-weight: 700; border-top: 1px solid #d1d5db;">' + formatPrice(19.26) + '</td></tr>' +
  '<tr><td colspan="2" style="padding: 6px 0 0 0; color: #6b7280; font-size: 11px; font-style: italic;">Previously quoted as £19.43 using an estimated Stripe fee of £0.41.</td></tr>' +
  '</table>' +
  '</td></tr></table>' +

  '<p style="font-size: 14px; color: #444; line-height: 1.6; margin: 0 0 16px 0;">This is the figure you\'ll see in your <a href="' + SITE_URL + '/pro/releases/orders/" style="color:#dc2626;font-weight:600;">artist dashboard</a> and what will be paid out. Nothing changes for the buyer, and no action is needed from you — just ship the record as per the original email.</p>' +

  '<p style="font-size: 14px; color: #444; line-height: 1.6; margin: 0;">Thanks,<br><strong>Fresh Wax</strong></p>' +

  '</td></tr>' +

  '<tr><td align="center" style="padding: 24px 0;">' +
  '<div><a href="' + SITE_URL + '" style="color: #dc2626; font-size: 12px; text-decoration: none; font-weight: 600;">freshwax.co.uk</a></div>' +
  '</td></tr>' +

  '</table></td></tr></table></body></html>';

(async () => {
  console.log(`Sending correction email to ${RECIPIENT}${TO_HANGRY ? '' : ' (PREVIEW)'} ...`);
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Fresh Wax Orders <orders@freshwax.co.uk>',
      to: [RECIPIENT],
      ...(TO_HANGRY ? { bcc: ['freshwaxonline@gmail.com'] } : {}),
      subject: (TO_HANGRY ? '' : '[PREVIEW] ') + 'Corrected payment figure - ' + orderNumber,
      html,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('Resend failed:', r.status, JSON.stringify(j)); process.exit(1); }
  console.log('Sent. Resend id:', j.id || '(none)');
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
