// src/lib/vinyl-order-emails.ts
// Email notifications for vinyl crates orders - seller and admin notifications

import { SITE_URL } from './constants';
import { emailWrapper, ctaButton, detailBox, esc } from './email-wrapper';
import { sendResendEmail } from './email';

// Send email to seller when their vinyl is purchased
export async function sendVinylOrderSellerEmail(
  sellerEmail: string,
  sellerName: string,
  orderDetails: {
    orderNumber: string;
    itemTitle: string;
    itemArtist: string;
    price: number;
    buyerName: string;
    buyerEmail: string;
    shippingAddress: any;
  },
  env: any
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    if (!sellerEmail) {
      console.log('[Vinyl Email] No seller email, skipping notification');
      return { success: false, error: 'No email address' };
    }

    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (!RESEND_API_KEY) {
      console.log('[Vinyl Email] No Resend API key configured');
      return { success: false, error: 'Email service not configured' };
    }

    const dashboardUrl = `${SITE_URL}/artist/vinyl/orders`;
    const formattedPrice = `\u00a3${orderDetails.price.toFixed(2)}`;
    const shipping = orderDetails.shippingAddress;

    const shippingHtml = shipping ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #1f1f1f; border-radius: 8px; margin-bottom: 25px;" class="detail-box">
        <tr>
          <td style="padding: 20px;">
            <p style="color: #f97316; font-size: 14px; font-weight: 600; margin: 0 0 10px;">SHIP TO:</p>
            <p style="color: #ffffff; font-size: 14px; margin: 0; line-height: 1.6;" class="text-primary">
              ${esc(shipping.firstName)} ${esc(shipping.lastName)}<br>
              ${esc(shipping.address1)}<br>
              ${shipping.address2 ? esc(shipping.address2) + '<br>' : ''}
              ${esc(shipping.city)}, ${esc(shipping.postcode)}<br>
              ${esc(shipping.country) || 'United Kingdom'}
            </p>
          </td>
        </tr>
      </table>
    ` : '';

    const content = `
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;" class="text-primary">
                Hey ${esc(sellerName) || 'there'},
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 25px; line-height: 1.6;" class="text-secondary">
                Great news! Someone just purchased your vinyl listing. Please ship the item to the buyer.
              </p>

              ${detailBox([
                { label: 'Order #', value: esc(orderDetails.orderNumber) },
                { label: 'Item', value: esc(orderDetails.itemTitle), valueColor: '#f97316' },
                { label: 'Artist', value: esc(orderDetails.itemArtist) },
                { label: 'Sale Price', value: formattedPrice, valueColor: '#22c55e' },
              ])}

              ${shippingHtml}

              <p style="color: #a3a3a3; font-size: 14px; margin: 0 0 25px; line-height: 1.6;" class="text-secondary">
                <strong style="color: #ffffff;" class="text-primary">Buyer:</strong> ${esc(orderDetails.buyerName)}<br>
                <strong style="color: #ffffff;" class="text-primary">Email:</strong> ${esc(orderDetails.buyerEmail)}
              </p>

              ${ctaButton('View Orders & Mark Shipped', dashboardUrl, { gradient: 'linear-gradient(135deg, #f97316 0%, #ea580c 100%)' })}

              <p style="color: #737373; font-size: 13px; margin: 0; line-height: 1.6;" class="text-muted">
                Please ship within your stated dispatch time. Add tracking info in your dashboard once shipped.
              </p>`;

    const emailHtml = emailWrapper(content, {
      title: 'New Vinyl Order!',
      headerText: 'New Vinyl Order!',
      headerGradient: 'linear-gradient(135deg, #f97316 0%, #ea580c 100%)',
      footerBrand: 'Fresh Wax Crates - Vinyl Marketplace',
    });

    const subject = `New Order: ${orderDetails.itemTitle} - #${orderDetails.orderNumber}`;
    const result = await sendResendEmail({
      apiKey: RESEND_API_KEY,
      from: 'Fresh Wax <orders@freshwax.co.uk>',
      to: [sellerEmail],
      subject,
      html: emailHtml,
      template: 'vinyl-order-seller',
      db: env?.DB,
    });

    return result;

  } catch (err) {
    console.error('[Vinyl Email] Error:', err);
    return { success: false, error: 'Email error' };
  }
}

// Send email to admin when vinyl is purchased
export async function sendVinylOrderAdminEmail(
  orderDetails: {
    orderNumber: string;
    sellerId: string;
    sellerName: string;
    sellerEmail: string;
    itemTitle: string;
    itemArtist: string;
    price: number;
    buyerName: string;
    buyerEmail: string;
  },
  env: any
): Promise<{ success: boolean; error?: string }> {
  try {
    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
    const ADMIN_EMAIL = env?.ADMIN_EMAIL || import.meta.env.ADMIN_EMAIL || 'admin@freshwax.co.uk';

    if (!RESEND_API_KEY) {
      return { success: false, error: 'Email service not configured' };
    }

    const content = `
              <h1 style="color: #f97316; margin-top: 0; font-size: 24px;" class="text-primary">Vinyl Crates Sale</h1>

              <p style="color: #ffffff; font-size: 14px; line-height: 1.8;" class="text-primary">
                <strong>Order:</strong> #${esc(orderDetails.orderNumber)}<br>
                <strong>Item:</strong> ${esc(orderDetails.itemTitle)} - ${esc(orderDetails.itemArtist)}<br>
                <strong>Price:</strong> \u00a3${orderDetails.price.toFixed(2)}
              </p>

              <hr style="border: none; border-top: 1px solid #333; margin: 20px 0;">

              <p style="color: #ffffff; font-size: 14px; line-height: 1.8;" class="text-primary">
                <strong>Seller:</strong> ${esc(orderDetails.sellerName)}<br>
                <strong>Seller Email:</strong> ${esc(orderDetails.sellerEmail)}<br>
                <strong>Seller ID:</strong> ${esc(orderDetails.sellerId)}
              </p>

              <hr style="border: none; border-top: 1px solid #333; margin: 20px 0;">

              <p style="color: #ffffff; font-size: 14px; line-height: 1.8;" class="text-primary">
                <strong>Buyer:</strong> ${esc(orderDetails.buyerName)}<br>
                <strong>Buyer Email:</strong> ${esc(orderDetails.buyerEmail)}
              </p>

              <p style="color: #737373; font-size: 12px; margin-top: 30px;" class="text-muted">
                Seller has been notified to ship the item.
              </p>`;

    const emailHtml = emailWrapper(content, {
      title: 'Vinyl Crates Sale',
      hideHeader: true,
    });

    const subject = `[Crates] Vinyl Sale: ${esc(orderDetails.itemTitle)} - #${esc(orderDetails.orderNumber)}`;
    const result = await sendResendEmail({
      apiKey: RESEND_API_KEY,
      from: 'Fresh Wax <orders@freshwax.co.uk>',
      to: [ADMIN_EMAIL],
      subject,
      html: emailHtml,
      template: 'vinyl-order-admin',
      db: env?.DB,
    });

    return result;

  } catch (err) {
    console.error('[Vinyl Email] Admin email error:', err);
    return { success: false, error: 'Email error' };
  }
}
