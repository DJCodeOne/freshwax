// src/pages/api/send-order-email.ts
// Sends order confirmation email to customer

import type { APIRoute } from 'astro';

// Conditional logging - only logs in development
const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const { orderId, orderNumber, order } = await request.json();
    
    log.info('[send-order-email] ========================================');
    log.info('[send-order-email] Received request for order:', orderNumber);
    log.info('[send-order-email] Order ID:', orderId);
    log.info('[send-order-email] Customer email:', order?.customer?.email);
    log.info('[send-order-email] Items count:', order?.items?.length);
    
    // Check if Resend API key is configured
    const RESEND_API_KEY = import.meta.env.RESEND_API_KEY;
    
    log.info('[send-order-email] API key present:', !!RESEND_API_KEY);
    if (RESEND_API_KEY) {
      log.info('[send-order-email] API key starts with:', RESEND_API_KEY.substring(0, 6) + '...');
    }
    
    if (!RESEND_API_KEY) {
      log.info('[send-order-email] ❌ No Resend API key configured, skipping email');
      return new Response(JSON.stringify({
        success: false,
        message: 'Email skipped - no API key configured'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (!order?.customer?.email) {
      log.info('[send-order-email] ❌ No customer email in order data');
      return new Response(JSON.stringify({
        success: false,
        error: 'No customer email provided'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Build email HTML
    const emailHtml = buildOrderEmailHtml(orderId, orderNumber, order);
    
    log.info('[send-order-email] Sending to:', order.customer.email);
    log.info('[send-order-email] From: Fresh Wax <orders@freshwax.co.uk>');
    
    // Extract short order number for subject (e.g., "FW-ABC123" from "FW-241204-abc123")
    const orderParts = orderNumber.split('-');
    const shortOrderNumber = orderParts.length >= 3 
      ? `${orderParts[0]}-${orderParts[orderParts.length - 1]}`.toUpperCase()
      : orderNumber;
    
    // Send via Resend
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Fresh Wax <orders@freshwax.co.uk>',
        to: [order.customer.email],
        subject: `Order Confirmed - ${shortOrderNumber}`,
        html: emailHtml
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.error('[send-order-email] ❌ Resend error:', response.status, error);
      throw new Error('Failed to send email: ' + error);
    }
    
    const result = await response.json();
    log.info('[send-order-email] ✓ Email sent successfully! ID:', result.id);
    
    return new Response(JSON.stringify({
      success: true,
      emailId: result.id
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('[send-order-email] ❌ Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send email'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

function buildOrderEmailHtml(orderId: string, orderNumber: string, order: any): string {
  const confirmationUrl = `https://freshwax.co.uk/order-confirmation/${orderId}`;
  
  // Extract short order number for customer display (e.g., "fw-abc123" from "FW-241204-abc123")
  // Keeps the fw- prefix and the unique ID, removes the date portion
  const orderParts = orderNumber.split('-');
  const shortOrderNumber = orderParts.length >= 3 
    ? `${orderParts[0]}-${orderParts[orderParts.length - 1]}`.toUpperCase()
    : orderNumber;
  
  const itemsHtml = order.items.map((item: any) => `
    <tr>
      <td style="padding: 14px 0; border-bottom: 1px solid #eee;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td width="56" style="padding-right: 14px; vertical-align: top;">
              <img src="${item.image || 'https://freshwax.co.uk/logo.webp'}" alt="${item.name}" width="56" height="56" style="border-radius: 6px; object-fit: cover; border: 1px solid #eee;">
            </td>
            <td style="vertical-align: top;">
              <div style="font-weight: 600; color: #111; margin-bottom: 3px; font-size: 14px;">${item.name}</div>
              <div style="font-size: 12px; color: #888;">
                ${item.type === 'merch' ? 'Merchandise' : item.type === 'release' || item.type === 'digital' ? 'Digital Download' : item.type || ''}
                ${item.size ? ` • Size: ${item.size}` : ''}
                ${item.color ? ` • ${item.color}` : ''}
                ${item.quantity > 1 ? ` • Qty: ${item.quantity}` : ''}
              </div>
            </td>
            <td width="70" style="text-align: right; font-weight: 600; color: #111; vertical-align: top; font-size: 14px;">
              £${(item.price * item.quantity).toFixed(2)}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `).join('');
  
  const hasDigitalItems = order.items.some((item: any) => 
    item.downloads?.tracks?.length > 0 || item.type === 'digital' || item.type === 'release'
  );
  
  const downloadSection = hasDigitalItems ? `
    <tr>
      <td style="background: #fff; padding: 16px 24px;">
        <div style="padding: 20px; background: #f0fdf4; border-radius: 8px; border: 1px solid #bbf7d0;">
          <div style="color: #166534; font-weight: 700; font-size: 15px; margin-bottom: 6px;">🎵 Your Downloads Are Ready</div>
          <div style="color: #15803d; font-size: 13px; margin-bottom: 14px;">
            Click below to access your digital purchases including MP3, WAV files and artwork.
          </div>
          <a href="${confirmationUrl}" style="display: inline-block; padding: 10px 20px; background: #16a34a; color: #fff; text-decoration: none; border-radius: 5px; font-weight: 700; font-size: 13px;">
            Download Your Music
          </a>
        </div>
      </td>
    </tr>
  ` : '';
  
  const shippingSection = order.shipping ? `
    <tr>
      <td style="background: #fff; padding: 0 24px 24px;">
        <div style="font-weight: 700; color: #333; margin-bottom: 10px; font-size: 14px;">Shipping To</div>
        <div style="color: #555; line-height: 1.6; font-size: 14px;">
          ${order.customer.firstName} ${order.customer.lastName}<br>
          ${order.shipping.address1}<br>
          ${order.shipping.address2 ? order.shipping.address2 + '<br>' : ''}
          ${order.shipping.city}, ${order.shipping.postcode}<br>
          ${order.shipping.county ? order.shipping.county + '<br>' : ''}
          ${order.shipping.country}
        </div>
      </td>
    </tr>
  ` : '';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Order Confirmation - ${shortOrderNumber}</title>
</head>
<body style="margin: 0; padding: 0; background: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #0a0a0a;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px;">
          
          <!-- Header -->
          <tr>
            <td align="center" style="padding: 32px 24px; background: #111; border-radius: 8px 8px 0 0;">
              <div style="font-size: 32px; font-weight: 800; letter-spacing: 0.02em;">
                <span style="color: #ffffff;">FRESH</span> <span style="color: #dc2626;">WAX</span>
              </div>
              <div style="color: #888; font-size: 12px; letter-spacing: 0.15em; margin-top: 6px;">JUNGLE • DRUM AND BASS</div>
            </td>
          </tr>
          
          <!-- Success Header (white background) -->
          <tr>
            <td style="background: #fff; padding: 32px 24px 0; border-radius: 0 0 0 0;">
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td align="center">
                    <div style="width: 56px; height: 56px; background: #dcfce7; border-radius: 50%; margin: 0 auto 16px; line-height: 56px; text-align: center;">
                      <span style="color: #16a34a; font-size: 28px;">✓</span>
                    </div>
                    <h1 style="margin: 0; color: #111; font-size: 26px; font-weight: 800;">Order Confirmed!</h1>
                    <p style="color: #666; font-size: 14px; margin: 8px 0 0;">Thank you for your purchase</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Order Number (short version for customer) -->
          <tr>
            <td align="center" style="background: #fff; padding: 24px 24px 0;">
              <div style="background: #f8f8f8; display: inline-block; padding: 16px 32px; border-radius: 8px; border: 1px solid #e5e5e5;">
                <div style="color: #999; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 4px;">Order Number</div>
                <div style="color: #dc2626; font-size: 22px; font-weight: 700; font-family: 'SF Mono', 'Menlo', monospace; letter-spacing: 0.05em;">${shortOrderNumber}</div>
              </div>
            </td>
          </tr>
          
          <!-- Download Section -->
          ${downloadSection}
          
          <!-- Order Details Header -->
          <tr>
            <td style="background: #fff; padding: 24px 24px 8px;">
              <div style="font-weight: 700; color: #dc2626; font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase;">Order Details</div>
            </td>
          </tr>
          
          <!-- Items -->
          <tr>
            <td style="background: #fff; padding: 0 24px;">
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                ${itemsHtml}
              </table>
            </td>
          </tr>
          
          <!-- Totals -->
          <tr>
            <td style="background: #fff; padding: 16px 24px 24px;">
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top: 1px solid #dc2626;">
                <tr>
                  <td style="color: #666; padding: 12px 0 6px;">Subtotal</td>
                  <td style="color: #111; text-align: right; padding: 12px 0 6px;">£${order.totals.subtotal.toFixed(2)}</td>
                </tr>
                <tr>
                  <td style="color: #666; padding: 6px 0;">Shipping</td>
                  <td style="color: ${order.hasPhysicalItems && order.totals.shipping === 0 ? '#16a34a' : '#111'}; text-align: right; padding: 6px 0; font-weight: ${order.hasPhysicalItems && order.totals.shipping === 0 ? '600' : '400'};">${order.hasPhysicalItems ? (order.totals.shipping === 0 ? 'FREE' : '£' + order.totals.shipping.toFixed(2)) : 'Digital delivery'}</td>
                </tr>
                <tr>
                  <td style="color: #111; font-weight: 700; font-size: 18px; padding: 16px 0 8px; border-top: 2px solid #111;">Total</td>
                  <td style="color: #dc2626; font-weight: 700; font-size: 18px; text-align: right; padding: 16px 0 8px; border-top: 2px solid #111;">£${order.totals.total.toFixed(2)}</td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Shipping Address -->
          ${shippingSection}
          
          <!-- View Order Button -->
          <tr>
            <td align="center" style="background: #fff; padding: 16px 24px 32px; border-radius: 0 0 8px 8px;">
              <a href="${confirmationUrl}" style="display: inline-block; padding: 14px 32px; background: #111; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 700; font-size: 14px;">
                View Order Details
              </a>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td align="center" style="padding: 24px 0;">
              <div style="color: #888; font-size: 13px; line-height: 1.6;">
                Thank you for shopping with Fresh<span style="color: #dc2626;">Wax</span><br>
                Questions? <a href="mailto:contact@freshwax.co.uk" style="color: #666;">contact@freshwax.co.uk</a>
              </div>
              <div style="margin-top: 12px;">
                <a href="https://freshwax.co.uk" style="color: #666; font-size: 12px; text-decoration: none;">freshwax.co.uk</a>
              </div>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}