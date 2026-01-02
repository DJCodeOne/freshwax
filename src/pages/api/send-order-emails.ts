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
    const { type, orderId, orderNumber, order, artistPayment, stockistOrder, customer, shipping } = await request.json();

    // Route to appropriate email handler based on type
    if (type === 'artist' && artistPayment) {
      return sendArtistEmail(orderId, orderNumber, artistPayment);
    }
    if (type === 'stockist' && stockistOrder) {
      return sendStockistEmail(orderId, orderNumber, stockistOrder, customer, shipping);
    }

    // Default: customer email
    
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
        bcc: ['freshwaxonline@gmail.com'],
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

// Send payment notification to artist/label
async function sendArtistEmail(orderId: string, orderNumber: string, artistPayment: any): Promise<Response> {
  const RESEND_API_KEY = import.meta.env.RESEND_API_KEY;

  if (!RESEND_API_KEY || !artistPayment.artistEmail) {
    log.info('[send-order-email] Skipping artist email - no API key or artist email');
    return new Response(JSON.stringify({ success: false, message: 'Artist email skipped' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  const itemsHtml = artistPayment.items.map((item: any) => `
    <tr>
      <td style="padding: 6px 8px; border-bottom: 1px solid #eee;">${item.name}</td>
      <td style="padding: 6px 8px; border-bottom: 1px solid #eee; text-align: right;">£${item.price.toFixed(2)}</td>
      <td style="padding: 6px 8px; border-bottom: 1px solid #eee; text-align: right; color: #16a34a; font-weight: 600;">£${item.artistShare.toFixed(2)}</td>
    </tr>
  `).join('');

  // Calculate totals with fallbacks for older orders
  const totalCustomerPaid = artistPayment.totalCustomerPaid || artistPayment.items.reduce((sum: number, i: any) => sum + (i.customerPaid || i.price), 0);
  const totalStripeFee = artistPayment.totalStripeFee || artistPayment.items.reduce((sum: number, i: any) => sum + (i.stripeFee || 0), 0);
  const totalPlatformFee = artistPayment.totalPlatformFee || artistPayment.items.reduce((sum: number, i: any) => sum + (i.platformFee || 0), 0);

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Sale Notification</title>
  <style>
    @media print {
      body { background: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .email-wrapper { padding: 0 !important; }
      .email-container { box-shadow: none !important; }
    }
    @page { margin: 0.5in; size: auto; }
  </style>
</head>
<body style="margin: 0; padding: 0; background: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" class="email-wrapper">
    <tr>
      <td align="center" style="padding: 20px 15px;">
        <table cellpadding="0" cellspacing="0" border="0" width="550" style="max-width: 550px; background: #fff; border-radius: 8px; overflow: hidden;" class="email-container">
          <!-- Header -->
          <tr>
            <td style="background: #111; padding: 16px; text-align: center;">
              <div style="font-size: 20px; font-weight: 800;"><span style="color: #fff;">FRESH</span> <span style="color: #dc2626;">WAX</span></div>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding: 20px;">
              <h1 style="margin: 0 0 4px; color: #16a34a; font-size: 18px;">You Made a Sale! 🎉</h1>
              <p style="color: #666; margin: 0 0 16px; font-size: 13px;">Order ${orderNumber}</p>

              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom: 16px; font-size: 13px;">
                <tr style="background: #f8f8f8;">
                  <th style="padding: 8px; text-align: left; font-weight: 600; color: #666;">Item</th>
                  <th style="padding: 8px; text-align: right; font-weight: 600; color: #666;">Price</th>
                  <th style="padding: 8px; text-align: right; font-weight: 600; color: #666;">Your Share</th>
                </tr>
                ${itemsHtml}
              </table>

              <!-- Payment Breakdown -->
              <div style="background: #f8f8f8; padding: 12px; border-radius: 6px; margin-bottom: 12px;">
                <div style="font-weight: 600; font-size: 11px; color: #666; text-transform: uppercase; margin-bottom: 8px;">Payment Breakdown</div>
                <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size: 12px;">
                  <tr>
                    <td style="padding: 3px 0; color: #16a34a; font-weight: 700;">Your Earnings:</td>
                    <td style="padding: 3px 0; text-align: right; color: #16a34a; font-weight: 700; font-size: 14px;">£${artistPayment.totalArtistShare.toFixed(2)}</td>
                  </tr>
                  <tr>
                    <td colspan="2" style="border-top: 1px dashed #ccc; padding-top: 4px; margin-top: 4px;"></td>
                  </tr>
                  <tr>
                    <td style="padding: 3px 0; color: #888; font-size: 11px;">+ Stripe Processing Fee:</td>
                    <td style="padding: 3px 0; text-align: right; color: #888; font-size: 11px;">£${totalStripeFee.toFixed(2)}</td>
                  </tr>
                  <tr>
                    <td style="padding: 3px 0; color: #888; font-size: 11px;">+ Fresh Wax Fee (1%):</td>
                    <td style="padding: 3px 0; text-align: right; color: #888; font-size: 11px;">£${totalPlatformFee.toFixed(2)}</td>
                  </tr>
                  <tr>
                    <td colspan="2" style="border-top: 1px solid #ddd; padding-top: 4px;"></td>
                  </tr>
                  <tr>
                    <td style="padding: 3px 0; color: #111;">Customer Paid:</td>
                    <td style="padding: 3px 0; text-align: right; color: #111; font-weight: 600;">£${totalCustomerPaid.toFixed(2)}</td>
                  </tr>
                </table>
              </div>

              <p style="color: #888; font-size: 11px; margin: 0; text-align: center;">
                Payments are processed monthly. View your earnings in your <a href="https://freshwax.co.uk/pro/dashboard" style="color: #dc2626;">Pro Dashboard</a>.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background: #f8f8f8; padding: 12px 20px; border-top: 1px solid #eee;">
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="font-size: 11px; color: #999;">Automated notification from Fresh Wax</td>
                  <td style="font-size: 11px; color: #999; text-align: right;"><a href="https://freshwax.co.uk" style="color: #999; text-decoration: none;">freshwax.co.uk</a></td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Fresh Wax <sales@freshwax.co.uk>',
        to: [artistPayment.artistEmail],
        subject: `You made a sale! - ${orderNumber}`,
        html
      })
    });

    if (!response.ok) throw new Error(await response.text());
    const result = await response.json();
    log.info('[send-order-email] Artist email sent:', result.id);
    return new Response(JSON.stringify({ success: true, emailId: result.id }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    log.error('[send-order-email] Artist email failed:', error);
    return new Response(JSON.stringify({ success: false, error: 'Failed to send artist email' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Send fulfillment request to stockist/supplier
async function sendStockistEmail(orderId: string, orderNumber: string, stockistOrder: any, customer: any, shipping: any): Promise<Response> {
  const RESEND_API_KEY = import.meta.env.RESEND_API_KEY;

  if (!RESEND_API_KEY || !stockistOrder.stockistEmail) {
    log.info('[send-order-email] Skipping stockist email - no API key or stockist email');
    return new Response(JSON.stringify({ success: false, message: 'Stockist email skipped' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  const itemsHtml = stockistOrder.items.map((item: any) => `
    <tr>
      <td style="padding: 10px; border: 1px solid #ddd;">${item.name}</td>
      <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${item.quantity}</td>
      <td style="padding: 10px; border: 1px solid #ddd;">${item.vinylColor || 'Standard'}</td>
    </tr>
  `).join('');

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Fulfillment Request</title></head>
<body style="margin: 0; padding: 0; background: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px; background: #fff; border-radius: 8px; overflow: hidden;">
          <tr>
            <td style="background: #111; padding: 24px; text-align: center;">
              <div style="font-size: 24px; font-weight: 800;"><span style="color: #fff;">FRESH</span> <span style="color: #dc2626;">WAX</span></div>
            </td>
          </tr>
          <tr>
            <td style="padding: 32px 24px;">
              <h1 style="margin: 0 0 8px; color: #111; font-size: 22px;">Fulfillment Request</h1>
              <p style="color: #666; margin: 0 0 24px;">Order ${orderNumber} - Please ship the following items</p>

              <h3 style="color: #333; margin: 0 0 12px;">Items to Ship</h3>
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom: 24px;">
                <tr style="background: #f8f8f8;">
                  <th style="padding: 10px; text-align: left; border: 1px solid #ddd;">Item</th>
                  <th style="padding: 10px; text-align: center; border: 1px solid #ddd;">Qty</th>
                  <th style="padding: 10px; text-align: left; border: 1px solid #ddd;">Variant</th>
                </tr>
                ${itemsHtml}
              </table>

              <h3 style="color: #333; margin: 0 0 12px;">Ship To</h3>
              <div style="background: #f8f8f8; padding: 16px; border-radius: 6px; margin-bottom: 24px;">
                <strong>${customer.firstName} ${customer.lastName}</strong><br>
                ${shipping?.address1 || ''}<br>
                ${shipping?.address2 ? shipping.address2 + '<br>' : ''}
                ${shipping?.city || ''}, ${shipping?.postcode || ''}<br>
                ${shipping?.county ? shipping.county + '<br>' : ''}
                ${shipping?.country || 'United Kingdom'}
              </div>

              <p style="color: #888; font-size: 13px; text-align: center;">
                Please update the order status once shipped at <a href="https://freshwax.co.uk/admin/orders" style="color: #dc2626;">admin panel</a>.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Fresh Wax <fulfillment@freshwax.co.uk>',
        to: [stockistOrder.stockistEmail],
        subject: `Fulfillment Request - ${orderNumber}`,
        html
      })
    });

    if (!response.ok) throw new Error(await response.text());
    const result = await response.json();
    log.info('[send-order-email] Stockist email sent:', result.id);
    return new Response(JSON.stringify({ success: true, emailId: result.id }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    log.error('[send-order-email] Stockist email failed:', error);
    return new Response(JSON.stringify({ success: false, error: 'Failed to send stockist email' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}