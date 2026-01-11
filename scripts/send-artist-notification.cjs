// scripts/send-artist-notification.js
// Run with: node scripts/send-artist-notification.js
// Sends digital sale notification to Max for SRS order

const https = require('https');
const fs = require('fs');

// Read RESEND_API_KEY from .env
const envContent = fs.readFileSync('.env', 'utf8');
const apiKeyMatch = envContent.match(/RESEND_API_KEY=([^\n\r]+)/);
const RESEND_API_KEY = apiKeyMatch[1].trim();

// Order details
const orderNumber = 'FW-260111-SRS001';
const customerName = 'Dave Hagon';
const artistEmail = 'undergroundlair.23@gmail.com';

// Financial breakdown
const digitalTotal = 2.00;
const freshWaxFee = 0.02;
const processingFee = 0.36;
const artistNetEarnings = 1.62;
const customerPaid = 2.00;

// Build items HTML
const itemsHtml = `<tr>
  <td style="padding: 12px; border-bottom: 1px solid #374151; color: #fff;">SRS - When Worlds Collide EP<br><span style="font-size: 12px; color: #9ca3af;">Digital Release</span></td>
  <td style="padding: 12px; border-bottom: 1px solid #374151; text-align: center; color: #fff;">1</td>
  <td style="padding: 12px; border-bottom: 1px solid #374151; text-align: right; font-weight: 600; color: #fff;">£${digitalTotal.toFixed(2)}</td>
</tr>`;

const emailHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background: #000; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #000;"><tr><td align="center" style="padding: 40px 20px;">
<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px;">
<tr><td style="background: #fff; padding: 32px 24px; border-radius: 12px 12px 0 0; text-align: center; border: 2px solid #dc2626; border-bottom: none;">
<img src="https://freshwax.co.uk/logo.webp" alt="Fresh Wax" width="50" height="50" style="display: block; margin: 0 auto 12px; border-radius: 6px;">
<div style="font-size: 28px; font-weight: 800; letter-spacing: 1px;"><span style="color: #000;">FRESH</span> <span style="color: #dc2626;">WAX</span></div>
<div style="font-size: 12px; color: #666; margin-top: 4px; letter-spacing: 2px;">JUNGLE • DRUM AND BASS</div>
</td></tr>
<tr><td style="background: #dc2626; padding: 20px 24px; text-align: center; border-left: 2px solid #dc2626; border-right: 2px solid #dc2626;">
<div style="font-size: 22px; font-weight: 800; color: #fff; letter-spacing: 1px;">🎵 DIGITAL SALE!</div>
<div style="font-size: 14px; color: rgba(255,255,255,0.9); margin-top: 6px;">Order ${orderNumber}</div>
</td></tr>
<tr><td style="background: #111; padding: 24px; border-left: 2px solid #dc2626; border-right: 2px solid #dc2626; border-bottom: 2px solid #dc2626; border-radius: 0 0 12px 12px;">
<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr><td style="padding-bottom: 20px; text-align: center;">
<div style="font-size: 18px; font-weight: 700; color: #16a34a;">Someone bought your music!</div>
<div style="font-size: 14px; color: #9ca3af; margin-top: 4px;">Customer: ${customerName}</div>
</td></tr>
<tr><td>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border: 1px solid #374151; border-radius: 8px; overflow: hidden; background: #1f2937;">
<tr style="background: #374151;">
<th style="padding: 12px; text-align: left; font-size: 12px; color: #9ca3af; text-transform: uppercase;">Item</th>
<th style="padding: 12px; text-align: center; font-size: 12px; color: #9ca3af; text-transform: uppercase;">Qty</th>
<th style="padding: 12px; text-align: right; font-size: 12px; color: #9ca3af; text-transform: uppercase;">Price</th>
</tr>
${itemsHtml}
<tr style="background: #dc2626;">
<td colspan="2" style="padding: 12px; color: #fff; font-weight: 700;">Your Earnings</td>
<td style="padding: 12px; color: #fff; font-weight: 700; text-align: right;">£${artistNetEarnings.toFixed(2)}</td>
</tr></table></td></tr>
<tr><td style="padding-top: 20px;">
<div style="padding: 16px; background: #1f2937; border-radius: 8px; border: 1px solid #374151;">
<div style="font-weight: 700; font-size: 12px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">Payment Breakdown</div>
<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr><td style="padding: 6px 0; color: #16a34a; font-size: 15px; font-weight: 700;">Your Payment:</td><td style="padding: 6px 0; text-align: right; color: #16a34a; font-size: 15px; font-weight: 700;">£${artistNetEarnings.toFixed(2)}</td></tr>
<tr><td colspan="2" style="padding: 8px 0; border-top: 1px dashed #374151;"></td></tr>
<tr><td style="padding: 4px 0; color: #6b7280; font-size: 13px;">Item Price:</td><td style="padding: 4px 0; text-align: right; color: #6b7280; font-size: 13px;">£${digitalTotal.toFixed(2)}</td></tr>
<tr><td style="padding: 4px 0; color: #6b7280; font-size: 13px;">Processing Fee:</td><td style="padding: 4px 0; text-align: right; color: #6b7280; font-size: 13px;">-£${processingFee.toFixed(2)}</td></tr>
<tr><td style="padding: 4px 0; color: #6b7280; font-size: 13px;"><span style="color: #fff;">Fresh</span> <span style="color: #dc2626;">Wax</span> Fee (1%):</td><td style="padding: 4px 0; text-align: right; color: #6b7280; font-size: 13px;">-£${freshWaxFee.toFixed(2)}</td></tr>
<tr><td colspan="2" style="padding: 8px 0; border-top: 1px dashed #374151;"></td></tr>
<tr><td style="padding: 6px 0; color: #fff; font-size: 15px; font-weight: 700;">Customer Paid:</td><td style="padding: 6px 0; text-align: right; color: #fff; font-size: 15px; font-weight: 700;">£${customerPaid.toFixed(2)}</td></tr>
</table></div></td></tr>
<tr><td style="padding-top: 20px;">
<div style="padding: 16px; background: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 0 8px 8px 0;">
<div style="font-weight: 700; color: #92400e; margin-bottom: 4px;">💰 Pending Payout</div>
<div style="font-size: 14px; color: #78350f; line-height: 1.5;">Your earnings are ready! Connect your payout method in your artist dashboard to receive payment.</div>
</div></td></tr>
</table></td></tr>
<tr><td align="center" style="padding: 24px 0;">
<div style="color: #6b7280; font-size: 13px;">Automated notification from Fresh Wax</div>
<div style="margin-top: 8px;"><a href="https://freshwax.co.uk" style="color: #dc2626; font-size: 12px; text-decoration: none; font-weight: 600;">freshwax.co.uk</a></div>
</td></tr>
</table></td></tr></table></body></html>`;

// Send the email
const emailData = JSON.stringify({
  from: 'Fresh Wax <orders@freshwax.co.uk>',
  to: [artistEmail],
  bcc: ['freshwaxonline@gmail.com'],
  subject: '🎵 Digital Sale! ' + orderNumber,
  html: emailHtml
});

const req = https.request({
  hostname: 'api.resend.com',
  path: '/emails',
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + RESEND_API_KEY,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(emailData)
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    const result = JSON.parse(data);
    if (res.statusCode === 200) {
      console.log('✅ Sale notification sent to', artistEmail);
      console.log('Email ID:', result.id);
    } else {
      console.log('Error:', result);
    }
  });
});

req.on('error', e => console.error('Error:', e.message));
req.write(emailData);
req.end();
