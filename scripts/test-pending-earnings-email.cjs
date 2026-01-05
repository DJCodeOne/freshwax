// Test script to send pending earnings email
// Usage: RESEND_API_KEY=your_key node scripts/test-pending-earnings-email.cjs

const RESEND_API_KEY = process.env.RESEND_API_KEY;

if (!RESEND_API_KEY) {
  console.error('Error: RESEND_API_KEY environment variable is required');
  console.error('Usage: RESEND_API_KEY=your_key node scripts/test-pending-earnings-email.cjs');
  process.exit(1);
}

const testEmail = 'davidhagon@gmail.com';
const testArtistName = 'Test Artist';
const testAmount = 12.50;

const connectUrl = 'https://freshwax.co.uk/artist/account?setup=stripe';
const formattedAmount = `£${testAmount.toFixed(2)}`;

const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You've got earnings waiting!</title>
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
                💰 You've Made a Sale!
              </h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;">
                Hey ${testArtistName},
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 25px; line-height: 1.6;">
                Great news! Someone just purchased your music on Fresh Wax. You've earned <strong style="color: #22c55e;">${formattedAmount}</strong> from this sale.
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 30px; line-height: 1.6;">
                To receive your payment, you need to connect your Stripe account. It only takes a few minutes and allows us to pay you directly.
              </p>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 10px 0 30px;">
                    <a href="${connectUrl}" style="display: inline-block; background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); color: #ffffff; text-decoration: none; padding: 16px 40px; border-radius: 8px; font-weight: 600; font-size: 16px;">
                      Connect Stripe & Get Paid →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="color: #737373; font-size: 14px; margin: 0 0 15px; line-height: 1.6;">
                Your earnings are held securely and will be transferred as soon as you connect your account.
              </p>

              <p style="color: #a3a3a3; font-size: 14px; margin: 0; line-height: 1.6;">
                If you have any questions, just reply to this email.
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

async function sendTestEmail() {
  console.log('Sending test pending earnings email to:', testEmail);
  console.log('Amount:', formattedAmount);

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Fresh Wax <noreply@freshwax.co.uk>',
      to: testEmail,
      subject: `💰 You've made a sale on Fresh Wax! Connect Stripe to get paid`,
      html: emailHtml
    })
  });

  const result = await response.json();

  if (!response.ok) {
    console.error('Failed to send email:', result);
    process.exit(1);
  }

  console.log('✓ Email sent successfully!');
  console.log('Message ID:', result.id);
}

sendTestEmail().catch(console.error);
