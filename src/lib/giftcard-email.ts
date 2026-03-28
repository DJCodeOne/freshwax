// src/lib/giftcard-email.ts
// Gift card email template for admin resend functionality

import { SITE_URL } from './constants';
import { emailWrapper, ctaButton, esc } from './email-wrapper';

/**
 * Build the HTML for a gift card email (used by admin resend feature).
 */
export function buildGiftCardEmail(params: {
  amount: number;
  cardCode: string;
  recipientName?: string;
}): string {
  const { amount, cardCode, recipientName } = params;

  const giftCardContent = `
        <h2 style="font-size: 28px; color: #111111; text-align: center; margin: 0 0 20px 0;" class="light-text">
          Your Gift Card Code
        </h2>

        <p style="color: #6b7280; text-align: center; margin-bottom: 30px;" class="light-text-secondary">
          ${recipientName ? `Hi ${esc(recipientName)},` : ''} Here's your <span style="color: #111111;" class="light-text">Fresh</span> <span style="color: #dc2626;">Wax</span> gift card code.
        </p>

        <!-- Gift Card Box -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 30px 0;">
          <tr>
            <td style="background: linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 100%); border-radius: 16px; padding: 30px; text-align: center;">
              <p style="color: #888; font-size: 14px; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 10px 0;">Gift Card Value</p>
              <p style="font-size: 48px; color: #dc2626; font-weight: 700; margin: 0 0 20px 0;">\u00a3${amount}</p>
              <p style="color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 10px 0;">Your Redemption Code</p>
              <table role="presentation" cellpadding="0" cellspacing="0" align="center">
                <tr>
                  <td style="background: #111; border: 2px solid #dc2626; border-radius: 10px; padding: 15px 25px;">
                    <code style="font-size: 24px; color: #fff; letter-spacing: 3px; font-family: 'Monaco', 'Consolas', monospace;">${esc(cardCode)}</code>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- How to Use -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 30px 0;">
          <tr>
            <td style="background: #f9f9f9; border-radius: 12px; padding: 25px;" class="light-detail-box">
              <h3 style="font-size: 18px; color: #111111; margin: 0 0 15px 0;" class="light-text">How to Redeem</h3>
              <ol style="color: #6b7280; font-size: 15px; line-height: 1.8; margin: 0; padding-left: 20px;" class="light-text-secondary">
                <li>Visit <a href="${SITE_URL}/giftcards/" style="color: #dc2626;">freshwax.co.uk/giftcards</a></li>
                <li>Sign in or create an account</li>
                <li>Enter your code above</li>
                <li>Start shopping!</li>
              </ol>
            </td>
          </tr>
        </table>

        ${ctaButton('Redeem Your Gift Card', SITE_URL + '/giftcards/')}`;

  return emailWrapper(giftCardContent, {
    title: 'Your Gift Card Code',
    hideHeader: true,
    lightTheme: true,
    footerBrand: 'Fresh Wax - Underground Jungle and Drum & Bass',
  });
}
