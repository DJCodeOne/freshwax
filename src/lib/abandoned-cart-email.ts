// src/lib/abandoned-cart-email.ts
// Sends abandoned cart recovery emails when Stripe checkout sessions expire

import { SITE_URL } from './constants';
import { emailWrapper, ctaButton, esc } from './email-wrapper';
import { sendResendEmail } from './email';
import { createLogger } from './api-utils';

const log = createLogger('abandoned-cart-email');

interface CartItem {
  name?: string;
  title?: string;
  artist?: string;
  price?: number;
  quantity?: number;
  image?: string;
  artwork?: string;
}

export async function sendAbandonedCartEmail(
  email: string,
  name: string | null,
  items: CartItem[],
  total: number,
  env: { RESEND_API_KEY?: string; DB?: import('@cloudflare/workers-types').D1Database } | undefined
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    if (!email) {
      return { success: false, error: 'No email address' };
    }

    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (!RESEND_API_KEY) {
      return { success: false, error: 'Email service not configured' };
    }

    const formattedTotal = `\u00a3${total.toFixed(2)}`;
    const greeting = name ? esc(name.split(' ')[0]) : 'there';
    const cartUrl = `${SITE_URL}/cart/`;
    const unsubUrl = `${SITE_URL}/account/settings/`;

    // Build items table rows
    const itemRows = items.map(item => {
      const itemName = esc(item.name || item.title || 'Item');
      const qty = item.quantity || 1;
      const price = (item.price || 0) * qty;
      const imgSrc = item.image || item.artwork || `${SITE_URL}/logo.webp`;

      return `
                      <tr>
                        <td style="padding: 12px 0; border-bottom: 1px solid #262626;" class="border-subtle">
                          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                            <tr>
                              <td width="60" style="vertical-align: top; max-width: 60px; width: 60px;">
                                <img src="${esc(imgSrc)}" alt="${itemName}" width="50" height="50" style="border-radius: 6px; object-fit: cover; display: block; max-width: 50px; height: auto;" />
                              </td>
                              <td style="vertical-align: top; padding-left: 12px; word-break: break-word; overflow: hidden;">
                                <p style="color: #ffffff; font-size: 14px; font-weight: 600; margin: 0 0 4px; word-break: break-word;" class="text-primary">${itemName}</p>
                                <p style="color: #737373; font-size: 13px; margin: 0;" class="text-muted">Qty: ${qty}</p>
                              </td>
                              <td width="70" align="right" style="vertical-align: top; white-space: nowrap;">
                                <p style="color: #ffffff; font-size: 14px; font-weight: 600; margin: 0;" class="text-primary">\u00a3${price.toFixed(2)}</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>`;
    }).join('');

    const content = `
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;" class="text-primary">
                Hey ${greeting},
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 25px; line-height: 1.6;" class="text-secondary">
                Looks like you didn't finish checking out. Your items are still waiting for you.
              </p>

              <!-- Items Table -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #1f1f1f; border-radius: 8px; margin-bottom: 25px;" class="detail-box">
                <tr>
                  <td style="padding: 16px 20px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      ${itemRows}
                      <tr>
                        <td colspan="3" style="padding-top: 16px;">
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                            <tr>
                              <td style="color: #a3a3a3; font-size: 14px; font-weight: 600;" class="text-secondary">Total</td>
                              <td align="right" style="color: #dc2626; font-size: 18px; font-weight: 700;">${formattedTotal}</td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              ${ctaButton('COMPLETE YOUR ORDER', cartUrl)}

              <p style="color: #737373; font-size: 13px; margin: 0; line-height: 1.6;" class="text-muted">
                Questions? Just reply to this email and we'll help you out.
              </p>`;

    const emailHtml = emailWrapper(content, {
      title: 'You left something behind!',
      headerText: 'You left something behind!',
      footerExtra: `<a href="${unsubUrl}" style="font-size: 11px; color: #525252; text-decoration: underline;" class="text-muted">Manage email preferences</a>`,
    });

    const subject = `You left ${items.length === 1 ? 'an item' : 'items'} in your cart - Fresh Wax`;
    const result = await sendResendEmail({
      apiKey: RESEND_API_KEY,
      from: 'Fresh Wax <noreply@freshwax.co.uk>',
      to: email,
      subject,
      html: emailHtml,
      template: 'abandoned-cart',
      db: env?.DB,
    });

    return result;

  } catch (error: unknown) {
    log.error('[Abandoned Cart] Error sending recovery email:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}
