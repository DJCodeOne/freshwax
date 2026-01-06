// scripts/send-test-newsletter.cjs
// Test script to send a newsletter directly via Resend
// Usage: node scripts/send-test-newsletter.cjs davidhagon@gmail.com

require('dotenv').config();
const { Resend } = require('resend');

const RESEND_API_KEY = process.env.RESEND_API_KEY;

if (!RESEND_API_KEY) {
  console.error('Error: RESEND_API_KEY not found in environment');
  process.exit(1);
}

const email = process.argv[2];
if (!email) {
  console.error('Usage: node scripts/send-test-newsletter.cjs <email>');
  process.exit(1);
}

const resend = new Resend(RESEND_API_KEY);

const subject = 'Fresh Wax Newsletter Test';
const content = `Hey there!

This is a **test newsletter** from Fresh Wax to confirm the newsletter system is working correctly.

## What's New

We're constantly adding new jungle and drum & bass releases to the store. Check out our latest drops!

**Featured this week:**
- New vinyl pressings arriving
- Exclusive digital releases
- Fresh DJ mixes from the community

[Browse Releases](https://freshwax.co.uk/releases)

## Stay Connected

Follow us on social media for updates and exclusive content.

Stay fresh! 🎵
*The Fresh Wax Team*`;

function generateNewsletterHTML(subject, content, recipientEmail) {
  let htmlContent = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/^### (.*$)/gm, '<h3 style="color: #fff; margin: 25px 0 15px;">$1</h3>')
    .replace(/^## (.*$)/gm, '<h2 style="color: #fff; margin: 30px 0 15px; font-size: 20px;">$1</h2>')
    .replace(/^# (.*$)/gm, '<h1 style="color: #fff; margin: 30px 0 20px; font-size: 24px;">$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong style="color: #fff;">$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" style="color: #dc2626; text-decoration: underline;">$1</a>')
    .replace(/\n\n/g, '</p><p style="color: #ccc; line-height: 1.7; margin-bottom: 15px;">')
    .replace(/\n/g, '<br>');

  htmlContent = `<p style="color: #ccc; line-height: 1.7; margin-bottom: 15px;">${htmlContent}</p>`;

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin: 0; padding: 0; background-color: #111; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <a href="https://freshwax.co.uk">
            <img src="https://freshwax.co.uk/logo.webp" alt="Fresh Wax" style="height: 60px; background: white; padding: 10px; border-radius: 8px;">
          </a>
        </div>

        <div style="background: #1a1a1a; border-radius: 12px; padding: 30px; color: #fff;">
          <h1 style="margin: 0 0 25px; font-size: 26px; color: #fff; border-bottom: 2px solid #dc2626; padding-bottom: 15px;">${subject}</h1>

          ${htmlContent}

          <div style="text-align: center; margin: 35px 0 20px;">
            <a href="https://freshwax.co.uk" style="display: inline-block; background: #dc2626; color: #fff; text-decoration: none; padding: 14px 30px; border-radius: 8px; font-weight: bold;">Visit Fresh Wax</a>
          </div>
        </div>

        <div style="text-align: center; margin-top: 30px; color: #666; font-size: 12px;">
          <p>© ${new Date().getFullYear()} Fresh Wax. All rights reserved.</p>
          <p style="margin-top: 10px;">
            <a href="https://freshwax.co.uk" style="color: #888; margin: 0 10px;">Website</a>
            <a href="https://freshwax.co.uk/releases" style="color: #888; margin: 0 10px;">Releases</a>
            <a href="https://freshwax.co.uk/dj-mixes" style="color: #888; margin: 0 10px;">DJ Mixes</a>
          </p>
          <p style="margin-top: 15px;">
            <a href="https://freshwax.co.uk/unsubscribe?email=${encodeURIComponent(recipientEmail)}" style="color: #666;">Unsubscribe from newsletter</a>
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
}

async function sendTestNewsletter() {
  console.log(`Sending test newsletter to: ${email}`);

  try {
    const result = await resend.emails.send({
      from: 'Fresh Wax <noreply@freshwax.co.uk>',
      to: email,
      subject: `[TEST] ${subject}`,
      html: generateNewsletterHTML(subject, content, email)
    });

    console.log('Newsletter sent successfully!');
    console.log('Result:', result);
  } catch (error) {
    console.error('Failed to send newsletter:', error);
    process.exit(1);
  }
}

sendTestNewsletter();
