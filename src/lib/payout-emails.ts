// src/lib/payout-emails.ts
// Email notifications for artist payouts and refunds

import { createLogger } from './api-utils';
import { SITE_URL } from './constants';
import { sendResendEmail } from './email';
import { emailWrapper, ctaButton, detailBox, esc } from './email-wrapper';

const log = createLogger('[payout-emails]');

// Send email notification when a payout is completed to an artist
export async function sendPayoutCompletedEmail(
  artistEmail: string,
  artistName: string,
  amount: number,
  orderNumber: string,
  env: { RESEND_API_KEY?: string; DB?: import('@cloudflare/workers-types').D1Database } | undefined
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    if (!artistEmail) {
      log.info('No email address for artist, skipping payout notification');
      return { success: false, error: 'No email address' };
    }

    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (!RESEND_API_KEY) {
      log.info('No Resend API key configured, skipping payout email');
      return { success: false, error: 'Email service not configured' };
    }

    const dashboardUrl = `${SITE_URL}/artist/payouts`;
    const formattedAmount = `\u00a3${amount.toFixed(2)}`;

    const content = `
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;" class="text-primary">
                Hey ${esc(artistName) || 'there'},
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 25px; line-height: 1.6;" class="text-secondary">
                We've just sent <strong style="color: #22c55e;">${formattedAmount}</strong> to your connected Stripe account from order <strong style="color: #ffffff;" class="text-primary">#${esc(orderNumber)}</strong>.
              </p>

              ${detailBox([
                { label: 'Amount', value: formattedAmount, valueColor: '#22c55e' },
                { label: 'Order', value: '#' + esc(orderNumber) },
              ])}

              <p style="color: #a3a3a3; font-size: 14px; margin: 0 0 25px; line-height: 1.6;" class="text-secondary">
                The funds will appear in your Stripe balance shortly and will be transferred to your bank account according to your payout schedule.
              </p>

              ${ctaButton('View Payout History', dashboardUrl, { gradient: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)' })}

              <p style="color: #737373; font-size: 13px; margin: 0; line-height: 1.6;" class="text-muted">
                Thanks for being part of Fresh Wax!
              </p>`;

    const emailHtml = emailWrapper(content, {
      title: 'Payment Sent!',
      headerText: 'Payment Sent!',
      headerGradient: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
    });

    const subject = `${formattedAmount} payment sent to your account - Order #${orderNumber}`;
    const result = await sendResendEmail({
      apiKey: RESEND_API_KEY,
      from: 'Fresh Wax <noreply@freshwax.co.uk>',
      to: artistEmail,
      subject,
      html: emailHtml,
      template: 'payout-completed',
      db: env?.DB,
    });

    return result;

  } catch (error: unknown) {
    log.error('Error sending payout completed email:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
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
  env: { RESEND_API_KEY?: string; DB?: import('@cloudflare/workers-types').D1Database } | undefined
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    if (!artistEmail) {
      log.info('No email address for artist, skipping refund notification');
      return { success: false, error: 'No email address' };
    }

    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (!RESEND_API_KEY) {
      log.info('No Resend API key configured, skipping refund email');
      return { success: false, error: 'Email service not configured' };
    }

    const dashboardUrl = `${SITE_URL}/artist/payouts`;
    const formattedRefund = `\u00a3${refundAmount.toFixed(2)}`;
    const formattedOriginal = `\u00a3${originalPayout.toFixed(2)}`;

    const content = `
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;" class="text-primary">
                Hey ${esc(artistName) || 'there'},
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 25px; line-height: 1.6;" class="text-secondary">
                A customer requested a ${isFullRefund ? 'full' : 'partial'} refund for order <strong style="color: #ffffff;" class="text-primary">#${esc(orderNumber)}</strong>. As a result, your earnings have been adjusted.
              </p>

              ${detailBox([
                { label: 'Original Payout', value: formattedOriginal },
                { label: 'Refund Amount', value: '-' + formattedRefund, valueColor: '#ef4444' },
                { label: 'Net Change', value: '-' + formattedRefund, valueColor: isFullRefund ? '#ef4444' : '#f59e0b' },
              ])}

              <p style="color: #a3a3a3; font-size: 14px; margin: 0 0 25px; line-height: 1.6;" class="text-secondary">
                ${isFullRefund
                  ? 'The full payout amount has been reversed from your Stripe balance.'
                  : 'A proportional amount has been reversed from your Stripe balance based on the refund percentage.'
                }
              </p>

              ${ctaButton('View Payout History', dashboardUrl, { gradient: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)' })}

              <p style="color: #737373; font-size: 13px; margin: 0; line-height: 1.6;" class="text-muted">
                Questions? Reply to this email and we'll help you out.
              </p>`;

    const emailHtml = emailWrapper(content, {
      title: 'Refund Processed',
      headerText: 'Refund Adjustment',
      headerGradient: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
    });

    const subject = `Refund adjustment: -${formattedRefund} from order #${orderNumber}`;
    const result = await sendResendEmail({
      apiKey: RESEND_API_KEY,
      from: 'Fresh Wax <noreply@freshwax.co.uk>',
      to: artistEmail,
      subject,
      html: emailHtml,
      template: 'refund-notification',
      db: env?.DB,
    });

    return result;

  } catch (error: unknown) {
    log.error('Error sending refund notification email:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}
