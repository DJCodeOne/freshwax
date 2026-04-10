// scripts/send-dj-bypass-email.cjs
// Sends "DJ bypass granted" notification email to all users currently in
// the djLobbyBypass collection (i.e. the recently approved DJs).
//
// IMPORTANT: defaults to DRY-RUN. Pass --confirm to actually send.
//
//   node scripts/send-dj-bypass-email.cjs              # dry run
//   node scripts/send-dj-bypass-email.cjs --confirm    # send for real
//
// Reads service account creds + RESEND_API_KEY from .env

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// --- .env loader ---
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

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'freshwax-store';
const PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = 'Fresh Wax <noreply@freshwax.co.uk>';
const SITE_URL = 'https://freshwax.co.uk';

if (!CLIENT_EMAIL || !PRIVATE_KEY) {
  console.error('Missing FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY in .env');
  process.exit(1);
}

const CONFIRM = process.argv.includes('--confirm');

// --- JWT helpers ---
function b64u(s) { return Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(claim));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}` }) });
  return (await r.json()).access_token;
}

const FB = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

async function listAll(token, col) {
  const docs = []; let pt = null;
  do {
    const url = `${FB}/${col}?pageSize=300${pt ? `&pageToken=${pt}` : ''}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    for (const doc of d.documents || []) docs.push({ id: doc.name.split('/').pop(), fields: doc.fields || {} });
    pt = d.nextPageToken || null;
  } while (pt);
  return docs;
}

function s(v) { return v?.stringValue || ''; }
function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// --- Email builder ---
function buildEmailHtml({ firstName }) {
  const safeName = escHtml(firstName);
  const lobbyUrl = `${SITE_URL}/account/dj-lobby/`;
  const loginUrl = `${SITE_URL}/login/`;

  // Self-contained HTML that mirrors the standard Fresh Wax wrapper
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>You're in — full DJ access granted</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:Arial,sans-serif;color:#e5e7eb;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0a0a0a;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#111111;border:1px solid #1f2937;border-radius:12px;overflow:hidden;">

        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#dc2626 0%,#991b1b 100%);padding:24px;text-align:center;">
          <h1 style="margin:0;font-size:28px;color:#ffffff;font-weight:900;letter-spacing:0.04em;text-transform:uppercase;">Fresh <span style="color:#ffffff;">Wax</span></h1>
          <p style="margin:8px 0 0;font-size:14px;color:#fecaca;">You're in. Full DJ access granted. 👑</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:32px 28px;">
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#e5e7eb;">Ez ${safeName},</p>

          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#e5e7eb;">Quick one — you've been granted full DJ access on Fresh Wax.</p>

          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#e5e7eb;">All restrictions lifted — you can go live without meeting the criteria. As a recognised DJ, your account now has full DJ privileges from day one.</p>

          <h2 style="margin:24px 0 12px;font-size:18px;color:#fbbf24;font-weight:700;">What this unlocks</h2>
          <ul style="margin:0 0 24px;padding-left:20px;color:#d1d5db;font-size:15px;line-height:1.7;">
            <li>Book live slots in the DJ Lobby and stream straight away</li>
            <li>Stream from a laptop (OBS / BUTT) <strong>or directly from your phone</strong> — no software needed, just open the page and hit Go Live</li>
            <li>Take over from another DJ mid-stream when they finish</li>
            <li>Multi-stream to your own Twitch account at the same time</li>
            <li>Share links ready to go the moment you're live</li>
          </ul>

          <!-- CTA -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center" style="padding:8px 0 24px;">
              <a href="${lobbyUrl}" style="display:inline-block;background:linear-gradient(135deg,#dc2626 0%,#b91c1c 100%);color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:16px;letter-spacing:0.3px;">Open DJ Lobby</a>
            </td></tr>
          </table>

          <h2 style="margin:24px 0 12px;font-size:18px;color:#fbbf24;font-weight:700;">Get started</h2>
          <ol style="margin:0 0 24px;padding-left:20px;color:#d1d5db;font-size:15px;line-height:1.7;">
            <li>Sign in at <a href="${loginUrl}" style="color:#fbbf24;text-decoration:underline;">freshwax.co.uk/login</a></li>
            <li>Head to your <a href="${lobbyUrl}" style="color:#fbbf24;text-decoration:underline;">DJ Lobby</a></li>
            <li>Book a slot, then go live when your time comes</li>
          </ol>

          <p style="margin:24px 0 16px;padding:14px 16px;background:rgba(245,158,11,0.08);border-left:3px solid #f59e0b;border-radius:4px;font-size:14px;color:#fde68a;line-height:1.6;">
            <strong>Heads up:</strong> Fresh Wax is in its final polish phase before the full production launch. If you spot anything broken, weird, or just plain wrong, please reply to this email — we'd rather hear it from you than guess.
          </p>

          <p style="margin:24px 0 0;font-size:16px;line-height:1.6;color:#e5e7eb;">Welcome aboard.</p>
          <p style="margin:8px 0 0;font-size:16px;color:#e5e7eb;">— Fresh Wax</p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 28px;background:#0a0a0a;border-top:1px solid #1f2937;text-align:center;">
          <p style="margin:0;font-size:12px;color:#6b7280;">You're getting this because you've been granted DJ access on Fresh Wax.</p>
          <p style="margin:6px 0 0;font-size:12px;color:#6b7280;">© ${new Date().getFullYear()} Fresh Wax — Jungle &amp; Drum &amp; Bass</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function sendViaResend({ to, subject, html }) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [to],
      subject,
      html,
    }),
  });
  if (!resp.ok) {
    throw new Error(`Resend ${resp.status}: ${await resp.text()}`);
  }
  return await resp.json();
}

// --- Run ---
(async () => {
  console.log(`\n=== DJ Bypass email — ${CONFIRM ? 'LIVE SEND 🔴' : 'DRY RUN 🟡'} ===\n`);

  const token = await getToken();
  const bypasses = await listAll(token, 'djLobbyBypass');
  console.log(`Found ${bypasses.length} djLobbyBypass entries\n`);

  // Build a recipient list with first names
  const recipients = bypasses
    .map((b) => {
      const f = b.fields;
      const email = s(f.email);
      const fullName = s(f.name) || 'there';
      const firstName = fullName.split(' ')[0] || fullName;
      return { uid: b.id, email, fullName, firstName };
    })
    .filter((r) => r.email && r.email.includes('@'));

  console.log(`${recipients.length} have a valid email address.\n`);

  if (recipients.length === 0) {
    console.log('No-one to email. Exiting.');
    return;
  }

  console.log('Recipients:');
  for (const r of recipients) {
    console.log(`  - ${r.fullName.padEnd(28)} ${r.email}`);
  }

  if (!CONFIRM) {
    console.log('\nDRY RUN — no emails sent.');
    console.log('Re-run with --confirm to send for real.\n');

    // Print one rendered preview
    const sample = recipients[0];
    const previewPath = path.resolve(__dirname, '..', 'tmp-dj-bypass-email-preview.html');
    fs.writeFileSync(previewPath, buildEmailHtml({ firstName: sample.firstName }));
    console.log(`Preview HTML for ${sample.firstName} written to:\n  ${previewPath}\n`);
    return;
  }

  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set in .env — cannot send.');
    process.exit(1);
  }

  console.log('\nSending...\n');
  let sent = 0; let failed = 0;
  for (const r of recipients) {
    try {
      const html = buildEmailHtml({ firstName: r.firstName });
      const result = await sendViaResend({
        to: r.email,
        subject: `You're in — full DJ access granted on Fresh Wax 👑`,
        html,
      });
      console.log(`  ✓ ${r.email}  (${result.id || 'queued'})`);
      sent++;
      // small delay to avoid hammering Resend
      await new Promise((r) => setTimeout(r, 250));
    } catch (err) {
      console.error(`  ! ${r.email}  ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. Sent: ${sent}, Failed: ${failed}\n`);
})().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
