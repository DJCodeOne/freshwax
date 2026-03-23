// src/lib/order/manual-order-email.ts
// Simple order confirmation email for manually created orders

import { SITE_URL } from '../constants';
import { formatPrice } from '../format-utils';

/**
 * Build a simple order confirmation email HTML for manual orders.
 */
export function buildManualOrderEmail(orderId: string, orderNumber: string, order: Record<string, unknown>): string {
  let itemsHtml = '';
  for (const item of order.items as Record<string, unknown>[]) {
    itemsHtml += `<tr>
      <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">${item.name}</td>
      <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatPrice((item.price as number) * (item.quantity as number))}</td>
    </tr>`;
  }

  const totals = order.totals as Record<string, unknown>;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f3f4f6; padding: 40px;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden;">
    <div style="background: #000; padding: 24px; text-align: center;">
      <h1 style="margin: 0; color: white;"><span style="color: white;">FRESH</span> <span style="color: #dc2626;">WAX</span></h1>
    </div>
    <div style="padding: 32px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <div style="font-size: 48px;">✓</div>
        <h2 style="margin: 8px 0;">Order Confirmed!</h2>
        <p style="color: #666;">Order Number: <strong style="color: #dc2626;">${orderNumber}</strong></p>
      </div>
      <table style="width: 100%; border-collapse: collapse;">
        <tr style="background: #f9fafb;">
          <th style="padding: 12px; text-align: left;">Item</th>
          <th style="padding: 12px; text-align: right;">Price</th>
        </tr>
        ${itemsHtml}
        <tr style="background: #000; color: white;">
          <td style="padding: 12px; font-weight: bold;">Total</td>
          <td style="padding: 12px; text-align: right; font-weight: bold;">${formatPrice(totals.total as number)}</td>
        </tr>
      </table>
      <div style="margin-top: 24px; padding: 16px; background: #dcfce7; border-radius: 8px;">
        <p style="margin: 0; color: #166534;"><strong>Your downloads are ready!</strong></p>
        <p style="margin: 8px 0 0; color: #166534;">Visit your account dashboard to download your music.</p>
      </div>
      <div style="text-align: center; margin-top: 24px;">
        <a href="${SITE_URL}/account/dashboard" style="display: inline-block; padding: 12px 24px; background: #dc2626; color: white; text-decoration: none; border-radius: 8px;">Go to Dashboard</a>
      </div>
    </div>
  </div>
</body>
</html>`;
}
