// scripts/test-payout-emails.cjs
// Test script to send sample payout emails

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TEST_EMAIL = 'davidhagon@gmail.com';

if (!RESEND_API_KEY) {
  console.error('Error: RESEND_API_KEY environment variable not set');
  console.log('Run with: RESEND_API_KEY=re_xxx node scripts/test-payout-emails.cjs');
  process.exit(1);
}

async function sendPayoutCompletedEmail() {
  const amount = 24.99;
  const orderNumber = 'FW-TEST123';
  const artistName = 'Test Artist';
  const formattedAmount = `£${amount.toFixed(2)}`;
  const dashboardUrl = 'https://freshwax.co.uk/artist/payouts';

  const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Sent!</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #141414; border-radius: 12px; overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); padding: 40px 40px 30px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700;">
                ✅ Payment Sent!
              </h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;">
                Hey ${artistName},
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 25px; line-height: 1.6;">
                We've just sent <strong style="color: #22c55e;">${formattedAmount}</strong> to your connected Stripe account from order <strong style="color: #ffffff;">#${orderNumber}</strong>.
              </p>

              <!-- Payment Details Box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #1f1f1f; border-radius: 8px; margin-bottom: 25px;">
                <tr>
                  <td style="padding: 20px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="color: #737373; font-size: 14px; padding-bottom: 10px;">Amount</td>
                        <td align="right" style="color: #22c55e; font-size: 18px; font-weight: 700; padding-bottom: 10px;">${formattedAmount}</td>
                      </tr>
                      <tr>
                        <td style="color: #737373; font-size: 14px;">Order</td>
                        <td align="right" style="color: #ffffff; font-size: 14px;">#${orderNumber}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="color: #a3a3a3; font-size: 14px; margin: 0 0 25px; line-height: 1.6;">
                The funds will appear in your Stripe balance shortly and will be transferred to your bank account according to your payout schedule.
              </p>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 10px 0 30px;">
                    <a href="${dashboardUrl}" style="display: inline-block; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 14px;">
                      View Payout History →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="color: #737373; font-size: 13px; margin: 0; line-height: 1.6;">
                Thanks for being part of Fresh Wax!
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #0a0a0a; padding: 25px 40px; border-top: 1px solid #262626;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <p style="font-size: 13px; margin: 0;">
                      <span style="color: #ffffff;">Fresh</span><span style="color: #dc2626;">Wax</span><span style="color: #ffffff;"> - Underground Music Platform</span>
                    </p>
                  </td>
                  <td align="right">
                    <a href="https://freshwax.co.uk" style="text-decoration: none; font-size: 13px; color: #ffffff;">freshwax.co.uk</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Fresh Wax <noreply@freshwax.co.uk>',
      to: TEST_EMAIL,
      subject: `✅ ${formattedAmount} payment sent to your account - Order #${orderNumber}`,
      html: emailHtml
    })
  });

  const result = await response.json();
  console.log('Payout completed email:', response.ok ? 'SENT' : 'FAILED', result);
  return response.ok;
}

async function sendRefundNotificationEmail() {
  const refundAmount = 12.50;
  const originalPayout = 24.99;
  const orderNumber = 'FW-TEST456';
  const artistName = 'Test Artist';
  const isFullRefund = false;
  const formattedRefund = `£${refundAmount.toFixed(2)}`;
  const formattedOriginal = `£${originalPayout.toFixed(2)}`;
  const dashboardUrl = 'https://freshwax.co.uk/artist/payouts';

  const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Refund Processed</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #141414; border-radius: 12px; overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 40px 40px 30px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700;">
                ↩️ Refund Adjustment
              </h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;">
                Hey ${artistName},
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 25px; line-height: 1.6;">
                A customer requested a ${isFullRefund ? 'full' : 'partial'} refund for order <strong style="color: #ffffff;">#${orderNumber}</strong>. As a result, your earnings have been adjusted.
              </p>

              <!-- Refund Details Box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #1f1f1f; border-radius: 8px; margin-bottom: 25px;">
                <tr>
                  <td style="padding: 20px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="color: #737373; font-size: 14px; padding-bottom: 10px;">Original Payout</td>
                        <td align="right" style="color: #ffffff; font-size: 16px; padding-bottom: 10px;">${formattedOriginal}</td>
                      </tr>
                      <tr>
                        <td style="color: #737373; font-size: 14px; padding-bottom: 10px;">Refund Amount</td>
                        <td align="right" style="color: #ef4444; font-size: 16px; padding-bottom: 10px;">-${formattedRefund}</td>
                      </tr>
                      <tr style="border-top: 1px solid #333;">
                        <td style="color: #737373; font-size: 14px; padding-top: 10px;">Net Change</td>
                        <td align="right" style="color: #f59e0b; font-size: 18px; font-weight: 700; padding-top: 10px;">-${formattedRefund}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="color: #a3a3a3; font-size: 14px; margin: 0 0 25px; line-height: 1.6;">
                A proportional amount has been reversed from your Stripe balance based on the refund percentage.
              </p>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 10px 0 30px;">
                    <a href="${dashboardUrl}" style="display: inline-block; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 14px;">
                      View Payout History →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="color: #737373; font-size: 13px; margin: 0; line-height: 1.6;">
                Questions? Reply to this email and we'll help you out.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #0a0a0a; padding: 25px 40px; border-top: 1px solid #262626;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <p style="font-size: 13px; margin: 0;">
                      <span style="color: #ffffff;">Fresh</span><span style="color: #dc2626;">Wax</span><span style="color: #ffffff;"> - Underground Music Platform</span>
                    </p>
                  </td>
                  <td align="right">
                    <a href="https://freshwax.co.uk" style="text-decoration: none; font-size: 13px; color: #ffffff;">freshwax.co.uk</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Fresh Wax <noreply@freshwax.co.uk>',
      to: TEST_EMAIL,
      subject: `↩️ Refund adjustment: -${formattedRefund} from order #${orderNumber}`,
      html: emailHtml
    })
  });

  const result = await response.json();
  console.log('Refund notification email:', response.ok ? 'SENT' : 'FAILED', result);
  return response.ok;
}

async function main() {
  console.log('Sending test emails to:', TEST_EMAIL);
  console.log('---');

  const payout = await sendPayoutCompletedEmail();
  const refund = await sendRefundNotificationEmail();

  console.log('---');
  if (payout && refund) {
    console.log('✓ Both test emails sent successfully!');
  } else {
    console.log('✕ Some emails failed to send');
  }
}

main().catch(console.error);
