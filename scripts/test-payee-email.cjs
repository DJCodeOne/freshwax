// One-off: send the new payee-notification email to a specific recipient
// for a specific order, mirroring the logic in src/lib/order/email-sender.ts.
// Used to preview the email template in production before relying on it for
// every future sale.
//
// Usage:
//   node scripts/test-payee-email.cjs <orderId> <payeeArtistId>
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
for (const raw of fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8').split('\n')) {
  const line = raw.trim(); if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('='); if (eq < 0) continue;
  const k = line.slice(0, eq).trim(); let v = line.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[k]) process.env[k] = v;
}

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'freshwax-store';
const PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SITE_URL = process.env.SITE_URL || 'https://freshwax.co.uk';

const orderId = process.argv[2];
const payeeId = process.argv[3];
if (!orderId || !payeeId) {
  console.error('usage: node scripts/test-payee-email.cjs <orderId> <payeeArtistId>');
  process.exit(1);
}

function b64u(s) { return Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function esc(s) { if (!s) return ''; return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function parseVal(v) {
  if (v == null) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.nullValue !== undefined) return null;
  if (v.mapValue) { const o = {}; for (const [k, val] of Object.entries(v.mapValue.fields || {})) o[k] = parseVal(val); return o; }
  if (v.arrayValue) return (v.arrayValue.values || []).map(parseVal);
  return null;
}

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + body + '.' + sig }) });
  return (await tr.json()).access_token;
}

(async () => {
  if (!RESEND_API_KEY) { console.error('RESEND_API_KEY not set'); process.exit(1); }
  const token = await getToken();
  const FB = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

  // Load order
  const ordRes = await fetch(`${FB}/orders/${orderId}`, { headers: { Authorization: 'Bearer ' + token } });
  if (!ordRes.ok) { console.error('Order not found'); process.exit(1); }
  const ordFields = (await ordRes.json()).fields || {};
  const orderNumber = parseVal(ordFields.orderNumber);
  const items = parseVal(ordFields.items) || [];
  const digitalItems = items.filter((i) => ['track', 'digital', 'release'].includes(i.type));

  // Resolve which items the payee is owed for
  const releaseIds = new Set(digitalItems.map((i) => i.releaseId || i.productId || i.id).filter(Boolean));
  const releaseEntries = await Promise.all([...releaseIds].map(async (id) => {
    const r = await fetch(`${FB}/releases/${id}`, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) return [id, null];
    const f = (await r.json()).fields || {};
    return [id, { artistId: parseVal(f.artistId), userId: parseVal(f.userId), payoutSplits: parseVal(f.payoutSplits) }];
  }));
  const releaseMap = new Map(releaseEntries.filter(([, d]) => d));

  const payeeItems = [];
  for (const item of digitalItems) {
    const releaseId = item.releaseId || item.productId || item.id;
    const release = releaseMap.get(releaseId);
    if (!release) continue;
    let recipients = [];
    if (Array.isArray(release.payoutSplits) && release.payoutSplits.length) {
      recipients = release.payoutSplits.filter((s) => s && s.artistId && (s.percentage > 0)).map((s) => s.artistId);
    } else {
      const aid = item.artistId || release.artistId || release.userId;
      if (aid) recipients = [aid];
    }
    if (recipients.includes(payeeId)) payeeItems.push(item);
  }

  // Resolve payee name + email
  const [aRes, uRes] = await Promise.all([
    fetch(`${FB}/artists/${payeeId}`, { headers: { Authorization: 'Bearer ' + token } }),
    fetch(`${FB}/users/${payeeId}`, { headers: { Authorization: 'Bearer ' + token } }),
  ]);
  const aFields = aRes.ok ? (await aRes.json()).fields || {} : {};
  const uFields = uRes.ok ? (await uRes.json()).fields || {} : {};
  const email = parseVal(aFields.email) || parseVal(uFields.email);
  const name = parseVal(aFields.artistName) || parseVal(aFields.displayName) || parseVal(uFields.displayName) || parseVal(uFields.name) || 'Artist';

  if (!email) { console.error('No email for payee', payeeId); process.exit(1); }
  console.log(`Payee: ${name} <${email}>`);
  console.log(`Items attributed to this payee on order ${orderNumber}: ${payeeItems.length}`);

  // Build the same item rows the email-sender would
  const formatItem = (item) => {
    const isTrack = item.type === 'track';
    const downloadTracks = item.downloads;
    const trackName = downloadTracks?.tracks?.[0]?.name;
    const releaseName = downloadTracks?.releaseName || item.title;
    if (isTrack && trackName) {
      if (releaseName && releaseName !== trackName) {
        return `${esc(trackName)} <span style="color:#999;">(from ${esc(releaseName)})</span>`;
      }
      return esc(trackName);
    }
    return esc(item.name || item.title || 'Untitled');
  };
  const seen = new Set();
  const rows = [];
  for (const item of payeeItems) {
    const html = formatItem(item);
    const key = html.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(`<li style="margin:0 0 8px;font-size:15px;line-height:1.5;color:#fff;">${html}</li>`);
    console.log(`  • ${item.name}`);
  }
  const itemsHtml = rows.length ? `<ul style="margin:0 0 24px;padding-left:20px;list-style:disc;">${rows.join('')}</ul>` : '';
  const itemWord = rows.length === 1 ? 'this' : 'these';

  // Match the existing on-brand seller email template: white branded
  // header card (FRESH WAX wordmark + tagline), red announcement strip,
  // dark content panel with 2px red outline, simple track list, red CTA.
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#000;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#000;"><tr><td align="center" style="padding:40px 20px;">
    <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;">

      <!-- White branded header -->
      <tr><td style="background:#fff;padding:32px 24px;border-radius:12px 12px 0 0;text-align:center;border:2px solid #dc2626;border-bottom:none;">
        <div style="font-size:32px;font-weight:900;letter-spacing:2px;line-height:1;">
          <span style="color:#000;">FRESH</span> <span style="color:#dc2626;">WAX</span>
        </div>
        <div style="font-size:11px;color:#666;margin-top:6px;letter-spacing:3px;font-weight:600;">JUNGLE &bull; DRUM AND BASS</div>
      </td></tr>

      <!-- Red announcement strip -->
      <tr><td style="background:#dc2626;padding:18px 24px;text-align:center;border-left:2px solid #dc2626;border-right:2px solid #dc2626;">
        <div style="font-size:20px;font-weight:800;color:#fff;letter-spacing:1px;">🎵 NEW SALE!</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.9);margin-top:4px;">Order ${esc(orderNumber)}</div>
      </td></tr>

      <!-- Dark content panel -->
      <tr><td style="background:#111;padding:32px 28px;border-left:2px solid #dc2626;border-right:2px solid #dc2626;border-bottom:2px solid #dc2626;border-radius:0 0 12px 12px;">

        <p style="font-size:18px;line-height:1.5;margin:0 0 12px;color:#fff;font-weight:700;">Ez ${esc(name)} 👋</p>
        <p style="font-size:15px;line-height:1.5;margin:0 0 20px;color:#d1d5db;">Someone just bought ${itemWord} on Fresh Wax:</p>

        <div style="background:#1f2937;border:1px solid #374151;border-radius:8px;padding:18px 20px;margin:0 0 24px;">
          ${rows.length ? `<ul style="margin:0;padding:0 0 0 20px;list-style:disc;">${rows.join('')}</ul>` : '<p style="margin:0;color:#9ca3af;">No items.</p>'}
        </div>

        <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center" style="padding:6px 0 22px;">
          <a href="${SITE_URL}/account/dashboard/" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:15px;letter-spacing:0.5px;text-transform:uppercase;">View Dashboard</a>
        </td></tr></table>

        <p style="font-size:12px;line-height:1.5;color:#9ca3af;margin:0 0 14px;text-align:center;">Your dashboard shows your share &amp; payout status. Payouts are processed manually.</p>
        <div style="background:#1f2937;border:1px solid #374151;border-radius:6px;padding:12px 16px;margin:0;">
          <p style="font-size:11px;line-height:1.5;color:#9ca3af;margin:0 0 4px;text-align:left;"><strong style="color:#fff;">Withdrawal fees:</strong></p>
          <p style="font-size:11px;line-height:1.5;color:#9ca3af;margin:0;text-align:left;">&bull; <span style="color:#fff;">PayPal</span> &mdash; PayPal's typical mass-payout fee (around &pound;0.20 GBP domestic, higher for international) is deducted from your payout. You'll receive the amount minus that fee.<br>&bull; <span style="color:#fff;">Stripe Connect</span> &mdash; no fee, but standard payouts take a few working days to land in your bank.</p>
        </div>
      </td></tr>

      <!-- Footer -->
      <tr><td align="center" style="padding:22px 0 0;">
        <div style="color:#9ca3af;font-size:12px;">Automated notification from FreshWax</div>
        <div style="margin-top:6px;"><a href="${SITE_URL}" style="font-size:12px;text-decoration:none;font-weight:600;"><span style="color:#fff;">fresh</span><span style="color:#dc2626;">wax</span><span style="color:#fff;">.co.uk</span></a></div>
      </td></tr>

    </table>
  </td></tr></table>
</body></html>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Fresh Wax <orders@freshwax.co.uk>',
      to: [email],
      bcc: ['freshwaxonline@gmail.com'],
      subject: '🎵 You have a new sale on Fresh Wax',
      html,
    }),
  });
  const body = await r.text();
  console.log('Resend status:', r.status);
  console.log('Resend body:', body);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
