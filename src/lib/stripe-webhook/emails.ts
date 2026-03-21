// src/lib/stripe-webhook/emails.ts
// Email notification helpers for Stripe webhook processing

import { SITE_URL } from '../constants';
import { formatPrice } from '../format-utils';
import { fetchWithTimeout, createLogger } from '../api-utils';
import { escapeHtml } from '../escape-html';

const log = createLogger('stripe-webhook-emails');

// Send email notification about pending earnings to artists without Stripe Connect
export async function sendPendingEarningsEmail(
  artistEmail: string,
  artistName: string,
  amount: number,
  env: CloudflareEnv
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    if (!artistEmail) {
      log.debug('[Stripe Webhook] No email address for artist, skipping notification');
      return { success: false, error: 'No email address' };
    }

    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (!RESEND_API_KEY) {
      log.debug('[Stripe Webhook] No Resend API key configured, skipping email');
      return { success: false, error: 'Email service not configured' };
    }

    const connectUrl = `${SITE_URL}/artist/account?setup=stripe`;
    const formattedAmount = formatPrice(amount);

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
                \u{1F4B0} You've Made a Sale!
              </h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;">
                Hey ${escapeHtml(artistName) || 'there'},
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
                      Connect Stripe & Get Paid \u2192
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
                    <a href="${SITE_URL}" style="text-decoration: none; font-size: 13px; color: #ffffff;">freshwax.co.uk</a>
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

    const response = await fetchWithTimeout('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Fresh Wax <noreply@freshwax.co.uk>',
        to: artistEmail,
        subject: `\u{1F4B0} You've made a sale on Fresh Wax! Connect Stripe to get paid`,
        html: emailHtml
      })
    }, 10000);

    if (!response.ok) {
      let errorBody: string | undefined;
      try { errorBody = await response.text(); } catch (_e: unknown) { /* non-critical: could not read error response body */ }
      log.error('[Stripe Webhook] Resend error:', response.status, errorBody);
      return { success: false, error: 'Failed to send email' };
    }

    const result = await response.json();
    log.debug('[Stripe Webhook] Pending earnings email sent');
    return { success: true, messageId: result.id };

  } catch (error: unknown) {
    log.error('[Stripe Webhook] Error sending pending earnings email:', error);
    return { success: false, error: 'Unknown error' };
  }
}

// Send email notification when a payout is completed to an artist
export async function sendPayoutCompletedEmail(
  artistEmail: string,
  artistName: string,
  amount: number,
  orderNumber: string,
  env: CloudflareEnv
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    if (!artistEmail) {
      log.debug('[Stripe Webhook] No email address for artist, skipping payout notification');
      return { success: false, error: 'No email address' };
    }

    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (!RESEND_API_KEY) {
      log.debug('[Stripe Webhook] No Resend API key configured, skipping payout email');
      return { success: false, error: 'Email service not configured' };
    }

    const dashboardUrl = `${SITE_URL}/artist/payouts`;
    const formattedAmount = formatPrice(amount);

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
                \u2705 Payment Sent!
              </h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;">
                Hey ${escapeHtml(artistName) || 'there'},
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 25px; line-height: 1.6;">
                We've just sent <strong style="color: #22c55e;">${formattedAmount}</strong> to your connected Stripe account from order <strong style="color: #ffffff;">#${escapeHtml(orderNumber)}</strong>.
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
                        <td align="right" style="color: #ffffff; font-size: 14px;">#${escapeHtml(orderNumber)}</td>
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
                      View Payout History \u2192
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
                    <a href="${SITE_URL}" style="text-decoration: none; font-size: 13px; color: #ffffff;">freshwax.co.uk</a>
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

    const response = await fetchWithTimeout('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Fresh Wax <noreply@freshwax.co.uk>',
        to: artistEmail,
        subject: `\u2705 ${formattedAmount} payment sent to your account - Order #${orderNumber}`,
        html: emailHtml
      })
    }, 10000);

    if (!response.ok) {
      let errorBody: string | undefined;
      try { errorBody = await response.text(); } catch (_e: unknown) { /* non-critical: could not read error response body */ }
      log.error('[Stripe Webhook] Resend error (payout email):', response.status, errorBody);
      return { success: false, error: 'Failed to send email' };
    }

    const result = await response.json();
    log.debug('[Stripe Webhook] Payout completed email sent');
    return { success: true, messageId: result.id };

  } catch (error: unknown) {
    log.error('[Stripe Webhook] Error sending payout completed email:', error);
    return { success: false, error: 'Unknown error' };
  }
}

// Send email notification when a refund affects artist earnings
export async function sendRefundNotificationEmail(
  artistEmail: string,
  artistName: string,
  refundAmount: number,
  originalPayout: number,
  orderNumber: string,
  isFullRefund: boolean,
  env: CloudflareEnv
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    if (!artistEmail) {
      log.debug('[Stripe Webhook] No email address for artist, skipping refund notification');
      return { success: false, error: 'No email address' };
    }

    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (!RESEND_API_KEY) {
      log.debug('[Stripe Webhook] No Resend API key configured, skipping refund email');
      return { success: false, error: 'Email service not configured' };
    }

    const dashboardUrl = `${SITE_URL}/artist/payouts`;
    const formattedRefund = formatPrice(refundAmount);
    const formattedOriginal = formatPrice(originalPayout);

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
                \u21A9\uFE0F Refund Adjustment
              </h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;">
                Hey ${artistName || 'there'},
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
                        <td align="right" style="color: ${isFullRefund ? '#ef4444' : '#f59e0b'}; font-size: 18px; font-weight: 700; padding-top: 10px;">-${formattedRefund}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="color: #a3a3a3; font-size: 14px; margin: 0 0 25px; line-height: 1.6;">
                ${isFullRefund
                  ? 'The full payout amount has been reversed from your Stripe balance.'
                  : 'A proportional amount has been reversed from your Stripe balance based on the refund percentage.'
                }
              </p>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 10px 0 30px;">
                    <a href="${dashboardUrl}" style="display: inline-block; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 14px;">
                      View Payout History \u2192
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
                    <a href="${SITE_URL}" style="text-decoration: none; font-size: 13px; color: #ffffff;">freshwax.co.uk</a>
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

    const response = await fetchWithTimeout('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Fresh Wax <noreply@freshwax.co.uk>',
        to: artistEmail,
        subject: `\u21A9\uFE0F Refund adjustment: -${formattedRefund} from order #${orderNumber}`,
        html: emailHtml
      })
    }, 10000);

    if (!response.ok) {
      let errorBody: string | undefined;
      try { errorBody = await response.text(); } catch (_e: unknown) { /* non-critical: could not read error response body */ }
      log.error('[Stripe Webhook] Resend error (refund email):', response.status, errorBody);
      return { success: false, error: 'Failed to send email' };
    }

    const result = await response.json();
    log.debug('[Stripe Webhook] Refund notification email sent');
    return { success: true, messageId: result.id };

  } catch (error: unknown) {
    log.error('[Stripe Webhook] Error sending refund notification email:', error);
    return { success: false, error: 'Unknown error' };
  }
}
