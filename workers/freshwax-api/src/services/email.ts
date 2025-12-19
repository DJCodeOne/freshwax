// Email Service - Handles sending emails via Resend
import type { Env } from '../types';

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

// Send email via Resend
export async function sendEmail(env: Env, options: EmailOptions): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.error('[email] RESEND_API_KEY not configured');
    return false;
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Fresh Wax <noreply@freshwax.co.uk>',
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
        reply_to: options.replyTo || 'contact@freshwax.co.uk'
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[email] Failed to send:', error);
      return false;
    }

    console.log(`[email] Sent to ${options.to}: ${options.subject}`);
    return true;
  } catch (error) {
    console.error('[email] Error:', error);
    return false;
  }
}

// ============================================
// EMAIL TEMPLATES
// ============================================

const baseStyles = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
  .container { max-width: 600px; margin: 0 auto; padding: 20px; }
  .header { background: #000; color: #fff; padding: 30px; text-align: center; }
  .header h1 { margin: 0; font-size: 28px; letter-spacing: 2px; }
  .content { padding: 30px; background: #fff; }
  .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; background: #f5f5f5; }
  .button { display: inline-block; padding: 12px 30px; background: #ef4444; color: #fff; text-decoration: none; font-weight: bold; margin: 20px 0; }
  .highlight { background: #f0fdf4; border-left: 4px solid #16a34a; padding: 15px; margin: 20px 0; }
  .warning { background: #fef2f2; border-left: 4px solid #dc2626; padding: 15px; margin: 20px 0; }
`;

// Artist approval email
export function artistApprovalEmail(artistName: string, displayName: string): EmailOptions {
  return {
    to: '', // Set by caller
    subject: `Welcome to Fresh Wax, ${artistName}!`,
    html: `
      <!DOCTYPE html>
      <html>
      <head><style>${baseStyles}</style></head>
      <body>
        <div class="container">
          <div class="header">
            <h1>FRESH WAX</h1>
          </div>
          <div class="content">
            <h2>Congratulations, ${displayName}!</h2>
            <p>Your artist application for <strong>${artistName}</strong> has been approved!</p>
            <div class="highlight">
              <strong>What's next?</strong>
              <ul>
                <li>Access your Pro Dashboard to manage your releases</li>
                <li>Upload your first release</li>
                <li>Set up your artist profile</li>
                <li>Start selling on Fresh Wax!</li>
              </ul>
            </div>
            <a href="https://freshwax.co.uk/account/dashboard" class="button">Go to Dashboard</a>
            <p>If you have any questions, just reply to this email and we'll help you out.</p>
            <p>Welcome to the family!<br><strong>The Fresh Wax Team</strong></p>
          </div>
          <div class="footer">
            <p>Fresh Wax - Jungle & Drum and Bass</p>
            <p><a href="https://freshwax.co.uk">freshwax.co.uk</a></p>
          </div>
        </div>
      </body>
      </html>
    `
  };
}

// Merch seller approval email
export function merchSellerApprovalEmail(businessName: string, displayName: string): EmailOptions {
  return {
    to: '', // Set by caller
    subject: `Your Merch Seller Account is Approved!`,
    html: `
      <!DOCTYPE html>
      <html>
      <head><style>${baseStyles}</style></head>
      <body>
        <div class="container">
          <div class="header">
            <h1>FRESH WAX</h1>
          </div>
          <div class="content">
            <h2>Welcome, ${displayName}!</h2>
            <p>Your merch seller application for <strong>${businessName}</strong> has been approved!</p>
            <div class="highlight">
              <strong>What's next?</strong>
              <ul>
                <li>Access your Pro Dashboard to manage your merchandise</li>
                <li>Add your products to the store</li>
                <li>Set up pricing and inventory</li>
                <li>Start selling!</li>
              </ul>
            </div>
            <a href="https://freshwax.co.uk/account/dashboard" class="button">Go to Dashboard</a>
            <p>Questions? Just reply to this email.</p>
            <p>Let's make some sales!<br><strong>The Fresh Wax Team</strong></p>
          </div>
          <div class="footer">
            <p>Fresh Wax - Jungle & Drum and Bass</p>
            <p><a href="https://freshwax.co.uk">freshwax.co.uk</a></p>
          </div>
        </div>
      </body>
      </html>
    `
  };
}

// DJ bypass approval email
export function djBypassApprovalEmail(displayName: string): EmailOptions {
  return {
    to: '', // Set by caller
    subject: `DJ Access Granted - Fresh Wax`,
    html: `
      <!DOCTYPE html>
      <html>
      <head><style>${baseStyles}</style></head>
      <body>
        <div class="container">
          <div class="header">
            <h1>FRESH WAX</h1>
          </div>
          <div class="content">
            <h2>You're In, ${displayName}!</h2>
            <p>Your DJ bypass request has been approved!</p>
            <div class="highlight">
              <strong>You can now:</strong>
              <ul>
                <li>Access the DJ Lobby</li>
                <li>Go live on Fresh Wax Radio</li>
                <li>Connect with other DJs</li>
                <li>Share your mixes with the community</li>
              </ul>
            </div>
            <a href="https://freshwax.co.uk/account/dj-lobby" class="button">Enter DJ Lobby</a>
            <p>See you in the booth!<br><strong>The Fresh Wax Team</strong></p>
          </div>
          <div class="footer">
            <p>Fresh Wax - Jungle & Drum and Bass</p>
            <p><a href="https://freshwax.co.uk">freshwax.co.uk</a></p>
          </div>
        </div>
      </body>
      </html>
    `
  };
}

// Role denial email
export function roleDenialEmail(displayName: string, roleType: string, reason?: string): EmailOptions {
  const roleName = roleType === 'artist' ? 'Artist' : roleType === 'merchSeller' ? 'Merch Seller' : 'DJ Bypass';

  return {
    to: '', // Set by caller
    subject: `Update on Your ${roleName} Application - Fresh Wax`,
    html: `
      <!DOCTYPE html>
      <html>
      <head><style>${baseStyles}</style></head>
      <body>
        <div class="container">
          <div class="header">
            <h1>FRESH WAX</h1>
          </div>
          <div class="content">
            <h2>Hi ${displayName},</h2>
            <p>Thank you for your interest in becoming a ${roleName.toLowerCase()} on Fresh Wax.</p>
            <div class="warning">
              <p>Unfortunately, we're unable to approve your application at this time.</p>
              ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
            </div>
            <p>This doesn't mean you can't apply again in the future. If you have questions or would like to discuss this, please reply to this email.</p>
            <p>Best regards,<br><strong>The Fresh Wax Team</strong></p>
          </div>
          <div class="footer">
            <p>Fresh Wax - Jungle & Drum and Bass</p>
            <p><a href="https://freshwax.co.uk">freshwax.co.uk</a></p>
          </div>
        </div>
      </body>
      </html>
    `
  };
}

// New pending request notification (to admin)
export function newRequestNotificationEmail(
  requestType: string,
  applicantName: string,
  applicantEmail: string,
  details: Record<string, string>
): EmailOptions {
  const detailsHtml = Object.entries(details)
    .map(([key, value]) => `<li><strong>${key}:</strong> ${value}</li>`)
    .join('');

  return {
    to: 'freshwaxonline@gmail.com',
    subject: `New ${requestType} Application - ${applicantName}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head><style>${baseStyles}</style></head>
      <body>
        <div class="container">
          <div class="header">
            <h1>FRESH WAX ADMIN</h1>
          </div>
          <div class="content">
            <h2>New ${requestType} Application</h2>
            <p><strong>Applicant:</strong> ${applicantName}</p>
            <p><strong>Email:</strong> ${applicantEmail}</p>
            <div class="highlight">
              <strong>Application Details:</strong>
              <ul>${detailsHtml}</ul>
            </div>
            <a href="https://freshwax.co.uk/admin/role-approvals" class="button">Review Application</a>
          </div>
          <div class="footer">
            <p>Fresh Wax Admin Notification</p>
          </div>
        </div>
      </body>
      </html>
    `
  };
}

// Order confirmation email
export function orderConfirmationEmail(
  customerName: string,
  orderId: string,
  items: Array<{ name: string; quantity: number; price: number }>,
  total: number,
  shippingAddress?: { line1: string; city: string; postcode: string }
): EmailOptions {
  const itemsHtml = items.map(item =>
    `<tr><td style="padding: 10px; border-bottom: 1px solid #eee;">${item.name}</td>
     <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: center;">${item.quantity}</td>
     <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right;">£${item.price.toFixed(2)}</td></tr>`
  ).join('');

  return {
    to: '', // Set by caller
    subject: `Order Confirmed - #${orderId}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head><style>${baseStyles}</style></head>
      <body>
        <div class="container">
          <div class="header">
            <h1>FRESH WAX</h1>
          </div>
          <div class="content">
            <h2>Thanks for your order, ${customerName}!</h2>
            <p>Order #${orderId} has been confirmed.</p>
            <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
              <thead>
                <tr style="background: #f5f5f5;">
                  <th style="padding: 10px; text-align: left;">Item</th>
                  <th style="padding: 10px; text-align: center;">Qty</th>
                  <th style="padding: 10px; text-align: right;">Price</th>
                </tr>
              </thead>
              <tbody>${itemsHtml}</tbody>
              <tfoot>
                <tr>
                  <td colspan="2" style="padding: 10px; text-align: right;"><strong>Total:</strong></td>
                  <td style="padding: 10px; text-align: right;"><strong>£${total.toFixed(2)}</strong></td>
                </tr>
              </tfoot>
            </table>
            ${shippingAddress ? `
              <div class="highlight">
                <strong>Shipping to:</strong><br>
                ${shippingAddress.line1}<br>
                ${shippingAddress.city}, ${shippingAddress.postcode}
              </div>
            ` : ''}
            <a href="https://freshwax.co.uk/account/orders" class="button">View Order</a>
            <p>Questions about your order? Just reply to this email.</p>
          </div>
          <div class="footer">
            <p>Fresh Wax - Jungle & Drum and Bass</p>
            <p><a href="https://freshwax.co.uk">freshwax.co.uk</a></p>
          </div>
        </div>
      </body>
      </html>
    `
  };
}
