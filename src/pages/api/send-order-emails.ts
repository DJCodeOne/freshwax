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
      <td style="padding: 16px 0; border-bottom: 1px solid #333;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td width="60" style="padding-right: 16px;">
              <img src="${item.image || 'https://freshwax.co.uk/logo.webp'}" alt="${item.name}" width="60" height="60" style="border-radius: 8px; object-fit: cover;">
            </td>
            <td style="vertical-align: top;">
              <div style="font-weight: 600; color: #fff; margin-bottom: 4px;">${item.name}</div>
              <div style="font-size: 13px; color: #888;">
                ${item.type || ''}
                ${item.size ? ` • Size: ${item.size}` : ''}
                ${item.color ? ` • ${item.color}` : ''}
                ${item.quantity > 1 ? ` • Qty: ${item.quantity}` : ''}
              </div>
            </td>
            <td width="80" style="text-align: right; font-weight: 600; color: #fff;">
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
      <td style="padding: 24px; background: #052e16; border-radius: 8px; margin-top: 24px;">
        <div style="color: #22c55e; font-weight: 700; font-size: 16px; margin-bottom: 8px;">🎵 Your Downloads Are Ready</div>
        <div style="color: #86efac; font-size: 14px; margin-bottom: 16px;">
          Click the button below to access your digital purchases including MP3, WAV files and artwork.
        </div>
        <a href="${confirmationUrl}" style="display: inline-block; padding: 12px 24px; background: #22c55e; color: #000; text-decoration: none; border-radius: 6px; font-weight: 700; font-size: 14px;">
          Download Your Music
        </a>
      </td>
    </tr>
  ` : '';
  
  const shippingSection = order.shipping ? `
    <tr>
      <td style="padding: 24px 0;">
        <div style="font-weight: 700; color: #fff; margin-bottom: 12px; font-size: 16px;">Shipping To</div>
        <div style="color: #ccc; line-height: 1.7;">
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
          
          <!-- Logo & Title -->
          <tr>
            <td align="center" style="padding-bottom: 32px;">
              <img src="https://freshwax.co.uk/logo.webp" alt="Fresh Wax" width="80" height="80" style="border-radius: 12px; margin-bottom: 16px;">
              <div style="font-size: 32px; font-weight: 800; letter-spacing: 0.02em;">
                <span style="color: #ffffff;">FRESH</span> <span style="color: #dc2626;">WAX</span>
              </div>
            </td>
          </tr>
          
          <!-- Success Header -->
          <tr>
            <td align="center" style="padding-bottom: 24px;">
              <div style="width: 60px; height: 60px; background: #052e16; border: 2px solid #22c55e; border-radius: 50%; margin: 0 auto 16px; line-height: 56px; text-align: center;">
                <span style="color: #22c55e; font-size: 28px;">✓</span>
              </div>
              <h1 style="margin: 0; color: #fff; font-size: 28px; font-weight: 800;">Order Confirmed!</h1>
            </td>
          </tr>
          
          <!-- Order Number (short version for customer) -->
          <tr>
            <td align="center" style="padding-bottom: 32px;">
              <div style="color: #888; font-size: 15px;">Order number</div>
              <div style="color: #fff; font-size: 20px; font-weight: 700; margin-top: 4px; font-family: monospace;">${shortOrderNumber}</div>
            </td>
          </tr>
          
          <!-- Download Section -->
          ${downloadSection}
          
          <!-- Items -->
          <tr>
            <td style="padding: 24px 0;">
              <div style="font-weight: 700; color: #fff; margin-bottom: 16px; font-size: 16px;">Order Details</div>
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                ${itemsHtml}
              </table>
            </td>
          </tr>
          
          <!-- Totals -->
          <tr>
            <td style="padding: 16px 0; border-top: 1px solid #333;">
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="color: #888; padding: 8px 0;">Subtotal</td>
                  <td style="color: #fff; text-align: right; padding: 8px 0;">£${order.totals.subtotal.toFixed(2)}</td>
                </tr>
                <tr>
                  <td style="color: #888; padding: 8px 0;">Shipping</td>
                  <td style="color: #fff; text-align: right; padding: 8px 0;">${order.hasPhysicalItems ? (order.totals.shipping === 0 ? 'FREE' : '£' + order.totals.shipping.toFixed(2)) : 'Digital delivery'}</td>
                </tr>
                <tr>
                  <td style="color: #fff; font-weight: 700; font-size: 18px; padding: 16px 0 8px; border-top: 2px solid #333;">Total</td>
                  <td style="color: #fff; font-weight: 700; font-size: 18px; text-align: right; padding: 16px 0 8px; border-top: 2px solid #333;">£${order.totals.total.toFixed(2)}</td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Shipping Address -->
          ${shippingSection}
          
          <!-- View Order Button -->
          <tr>
            <td align="center" style="padding: 32px 0;">
              <a href="${confirmationUrl}" style="display: inline-block; padding: 14px 32px; background: #fff; color: #000; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 15px;">
                View Order Details
              </a>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td align="center" style="padding: 32px 0; border-top: 1px solid #333;">
              <div style="color: #666; font-size: 13px; line-height: 1.6;">
                Thank you for shopping with <span style="color: #fff;">Fresh</span> <span style="color: #dc2626;">Wax</span>!<br>
                Questions? Reply to this email or visit our <a href="https://freshwax.co.uk/contact" style="color: #888;">contact page</a>.
              </div>
              <div style="margin-top: 16px;">
                <a href="https://freshwax.co.uk" style="color: #888; font-size: 12px; text-decoration: none;">freshwax.co.uk</a>
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