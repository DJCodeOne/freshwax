// Send welcome/confirmation email to new artist
// Usage: RESEND_API_KEY=xxx node scripts/send-welcome-email.js [test-email]

const testEmail = process.argv[2] || 'davidhagon@gmail.com';

const artistData = {
  name: 'Y2',
  email: 'vaughnb1980@live.co.uk',
  roles: ['Artist', 'Merch Supplier', 'Vinyl Crates Seller'],
  registeredAt: '9th January 2026'
};

const releaseData = {
  title: 'Ultron EP',
  artist: 'Skru',
  label: 'Danger Chamber',
  trackCount: 5,
  price: '£6.50',
  url: 'https://freshwax.co.uk/item/skru_ultron-ep_FW-1767981893',
  tracks: ['Emigre', 'Jah Phantom', 'Kitano', 'The Grayl', 'Ultron']
};

const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to Fresh Wax!</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #141414; border-radius: 12px; overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%); padding: 40px 40px 30px; text-align: center;">
              <p style="margin: 0 0 15px; font-size: 36px; font-weight: 900; letter-spacing: 2px;">
                <span style="color: #ffffff;">FRESH</span> <span style="color: #ef4444;">WAX</span>
              </p>
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700;">
                Welcome to the Family!
              </h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;">
                Big up ${artistData.name},
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 25px; line-height: 1.6;">
                Your Fresh Wax account has been approved and you're all set up! Here's a summary of your account:
              </p>

              <!-- Account Details Box -->
              <div style="background-color: #1f1f1f; border-radius: 8px; padding: 25px; margin-bottom: 30px; border-left: 4px solid #ef4444;">
                <h3 style="color: #ffffff; font-size: 16px; margin: 0 0 15px; text-transform: uppercase; letter-spacing: 1px;">Account Details</h3>
                <table width="100%" style="color: #a3a3a3; font-size: 14px;">
                  <tr>
                    <td style="padding: 5px 0; color: #737373;">Display Name:</td>
                    <td style="padding: 5px 0; color: #ffffff; text-align: right;">${artistData.name}</td>
                  </tr>
                  <tr>
                    <td style="padding: 5px 0; color: #737373;">Approved Roles:</td>
                    <td style="padding: 5px 0; color: #22c55e; text-align: right; font-weight: 600;">${artistData.roles.join(', ')}</td>
                  </tr>
                  <tr>
                    <td style="padding: 5px 0; color: #737373;">Registered:</td>
                    <td style="padding: 5px 0; color: #ffffff; text-align: right;">${artistData.registeredAt}</td>
                  </tr>
                </table>
              </div>

              <!-- Release Info Box -->
              <div style="background-color: #1f1f1f; border-radius: 8px; padding: 25px; margin-bottom: 30px; border-left: 4px solid #22c55e;">
                <h3 style="color: #ffffff; font-size: 16px; margin: 0 0 15px; text-transform: uppercase; letter-spacing: 1px;">Your Release is Live!</h3>
                <table width="100%" style="color: #a3a3a3; font-size: 14px;">
                  <tr>
                    <td style="padding: 5px 0; color: #737373;">Release:</td>
                    <td style="padding: 5px 0; color: #ffffff; text-align: right; font-weight: 600;">${releaseData.artist} - ${releaseData.title}</td>
                  </tr>
                  <tr>
                    <td style="padding: 5px 0; color: #737373;">Label:</td>
                    <td style="padding: 5px 0; color: #ffffff; text-align: right;">${releaseData.label}</td>
                  </tr>
                  <tr>
                    <td style="padding: 5px 0; color: #737373;">Tracks:</td>
                    <td style="padding: 5px 0; color: #ffffff; text-align: right;">${releaseData.trackCount} tracks</td>
                  </tr>
                  <tr>
                    <td style="padding: 5px 0; color: #737373;">Price:</td>
                    <td style="padding: 5px 0; color: #22c55e; text-align: right; font-weight: 600;">${releaseData.price}</td>
                  </tr>
                </table>
                <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #333;">
                  <p style="color: #737373; font-size: 13px; margin: 0 0 12px; text-transform: uppercase; letter-spacing: 0.5px;">Tracklist:</p>
                  <table width="100%" cellpadding="0" cellspacing="0">
                    ${releaseData.tracks.map((t, i) => `
                    <tr>
                      <td style="padding: 8px 12px; background-color: ${i % 2 === 0 ? '#262626' : '#1f1f1f'}; border-radius: ${i === 0 ? '6px 6px 0 0' : i === releaseData.tracks.length - 1 ? '0 0 6px 6px' : '0'}; text-align: left;">
                        <span style="color: #ef4444; font-weight: 600; font-size: 13px; margin-right: 12px;">${String(i + 1).padStart(2, '0')}</span>
                        <span style="color: #e5e5e5; font-size: 14px;">${t}</span>
                      </td>
                    </tr>`).join('')}
                  </table>
                </div>
              </div>

              <!-- CTA Button -->
              <div style="text-align: center; margin: 30px 0;">
                <a href="${releaseData.url}" style="display: inline-block; background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); color: #ffffff; text-decoration: none; padding: 15px 40px; border-radius: 8px; font-weight: 600; font-size: 16px;">
                  View Your Release
                </a>
              </div>

              <p style="color: #a3a3a3; font-size: 15px; margin: 25px 0 0; line-height: 1.6;">
                As an approved artist, you can now:
              </p>
              <ul style="color: #a3a3a3; font-size: 14px; margin: 10px 0 25px; padding-left: 20px; line-height: 1.8;">
                <li>Upload new releases via your <a href="https://freshwax.co.uk/artist/dashboard" style="color: #ef4444;">Artist Dashboard</a></li>
                <li>Track your sales and earnings</li>
                <li>Receive automatic payouts when your music sells</li>
                <li>List merchandise in the Fresh Wax store</li>
              </ul>

              <p style="color: #a3a3a3; font-size: 15px; margin: 0; line-height: 1.6;">
                If you have any questions, just reply to this email or reach out at <a href="mailto:contact@freshwax.co.uk" style="color: #ef4444;">contact@freshwax.co.uk</a>.
              </p>

              <p style="color: #ffffff; font-size: 15px; margin: 25px 0 0; line-height: 1.6;">
                Welcome aboard!<br>
                <strong>The Fresh Wax Team</strong>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #0a0a0a; padding: 25px 40px; text-align: center; border-top: 1px solid #262626;">
              <p style="margin: 0 0 10px; font-size: 24px; font-weight: 900; letter-spacing: 1px;">
                <span style="color: #ffffff;">FRESH</span> <span style="color: #ef4444;">WAX</span>
              </p>
              <p style="color: #525252; font-size: 12px; margin: 0 0 10px;">
                Jungle & Drum and Bass
              </p>
              <p style="color: #525252; font-size: 12px; margin: 0;">
                <a href="https://freshwax.co.uk" style="color: #737373;">freshwax.co.uk</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

async function sendEmail() {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  if (!RESEND_API_KEY) {
    console.error('Error: RESEND_API_KEY environment variable not set');
    console.log('Usage: RESEND_API_KEY=your_key node scripts/send-welcome-email.js [test-email]');
    process.exit(1);
  }

  console.log(`Sending test email to: ${testEmail}`);

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Fresh Wax <noreply@freshwax.co.uk>',
        to: [testEmail],
        subject: 'Welcome to Fresh Wax - Your Account is Ready!',
        html: emailHtml
      })
    });

    const result = await response.json();

    if (response.ok) {
      console.log('Email sent successfully!');
      console.log('Message ID:', result.id);
    } else {
      console.error('Failed to send email:', result);
    }
  } catch (error) {
    console.error('Error sending email:', error);
  }
}

sendEmail();
