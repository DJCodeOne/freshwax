// src/lib/vinyl-order-emails.ts
// Email notifications for vinyl crates orders - seller and admin notifications

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

    const dashboardUrl = 'https://freshwax.co.uk/artist/vinyl/orders';
    const formattedPrice = `£${orderDetails.price.toFixed(2)}`;
    const shipping = orderDetails.shippingAddress;

    const shippingHtml = shipping ? `
      <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #1f1f1f; border-radius: 8px; margin-bottom: 25px;">
        <tr>
          <td style="padding: 20px;">
            <p style="color: #f97316; font-size: 14px; font-weight: 600; margin: 0 0 10px;">SHIP TO:</p>
            <p style="color: #ffffff; font-size: 14px; margin: 0; line-height: 1.6;">
              ${shipping.firstName || ''} ${shipping.lastName || ''}<br>
              ${shipping.address1 || ''}<br>
              ${shipping.address2 ? shipping.address2 + '<br>' : ''}
              ${shipping.city || ''}, ${shipping.postcode || ''}<br>
              ${shipping.country || 'United Kingdom'}
            </p>
          </td>
        </tr>
      </table>
    ` : '';

    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Vinyl Order!</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #141414; border-radius: 12px; overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); padding: 40px 40px 30px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700;">
                📦 New Vinyl Order!
              </h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;">
                Hey ${sellerName || 'there'},
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 25px; line-height: 1.6;">
                Great news! Someone just purchased your vinyl listing. Please ship the item to the buyer.
              </p>

              <!-- Order Details Box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #1f1f1f; border-radius: 8px; margin-bottom: 25px;">
                <tr>
                  <td style="padding: 20px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="color: #737373; font-size: 14px; padding-bottom: 10px;">Order #</td>
                        <td align="right" style="color: #ffffff; font-size: 14px; padding-bottom: 10px;">${orderDetails.orderNumber}</td>
                      </tr>
                      <tr>
                        <td style="color: #737373; font-size: 14px; padding-bottom: 10px;">Item</td>
                        <td align="right" style="color: #f97316; font-size: 14px; font-weight: 600; padding-bottom: 10px;">${orderDetails.itemTitle}</td>
                      </tr>
                      <tr>
                        <td style="color: #737373; font-size: 14px; padding-bottom: 10px;">Artist</td>
                        <td align="right" style="color: #ffffff; font-size: 14px; padding-bottom: 10px;">${orderDetails.itemArtist}</td>
                      </tr>
                      <tr>
                        <td style="color: #737373; font-size: 14px;">Sale Price</td>
                        <td align="right" style="color: #22c55e; font-size: 18px; font-weight: 700;">${formattedPrice}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              ${shippingHtml}

              <p style="color: #a3a3a3; font-size: 14px; margin: 0 0 25px; line-height: 1.6;">
                <strong style="color: #ffffff;">Buyer:</strong> ${orderDetails.buyerName}<br>
                <strong style="color: #ffffff;">Email:</strong> ${orderDetails.buyerEmail}
              </p>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 10px 0 30px;">
                    <a href="${dashboardUrl}" style="display: inline-block; background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 14px;">
                      View Orders & Mark Shipped →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="color: #737373; font-size: 13px; margin: 0; line-height: 1.6;">
                Please ship within your stated dispatch time. Add tracking info in your dashboard once shipped.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #0f0f0f; padding: 25px 40px; text-align: center; border-top: 1px solid #262626;">
              <p style="color: #525252; font-size: 12px; margin: 0;">
                Fresh Wax Crates - Vinyl Marketplace
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Fresh Wax <orders@freshwax.co.uk>',
        to: [sellerEmail],
        subject: `📦 New Order: ${orderDetails.itemTitle} - #${orderDetails.orderNumber}`,
        html: emailHtml
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[Vinyl Email] Resend error:', error);
      return { success: false, error: 'Email send failed' };
    }

    const result = await response.json();
    console.log('[Vinyl Email] Seller notification sent:', result.id);
    return { success: true, messageId: result.id };

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

    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Vinyl Crates Sale</title>
</head>
<body style="margin: 0; padding: 20px; background-color: #0a0a0a; font-family: sans-serif; color: #ffffff;">
  <div style="max-width: 600px; margin: 0 auto; background: #141414; padding: 30px; border-radius: 12px;">
    <h1 style="color: #f97316; margin-top: 0;">Vinyl Crates Sale</h1>

    <p><strong>Order:</strong> #${orderDetails.orderNumber}</p>
    <p><strong>Item:</strong> ${orderDetails.itemTitle} - ${orderDetails.itemArtist}</p>
    <p><strong>Price:</strong> £${orderDetails.price.toFixed(2)}</p>

    <hr style="border: none; border-top: 1px solid #333; margin: 20px 0;">

    <p><strong>Seller:</strong> ${orderDetails.sellerName}</p>
    <p><strong>Seller Email:</strong> ${orderDetails.sellerEmail}</p>
    <p><strong>Seller ID:</strong> ${orderDetails.sellerId}</p>

    <hr style="border: none; border-top: 1px solid #333; margin: 20px 0;">

    <p><strong>Buyer:</strong> ${orderDetails.buyerName}</p>
    <p><strong>Buyer Email:</strong> ${orderDetails.buyerEmail}</p>

    <p style="color: #737373; font-size: 12px; margin-top: 30px;">
      Seller has been notified to ship the item.
    </p>
  </div>
</body>
</html>`;

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Fresh Wax <orders@freshwax.co.uk>',
        to: [ADMIN_EMAIL],
        subject: `[Crates] Vinyl Sale: ${orderDetails.itemTitle} - #${orderDetails.orderNumber}`,
        html: emailHtml
      })
    });

    if (!response.ok) {
      return { success: false, error: 'Admin email failed' };
    }

    console.log('[Vinyl Email] Admin notification sent');
    return { success: true };

  } catch (err) {
    console.error('[Vinyl Email] Admin email error:', err);
    return { success: false, error: 'Email error' };
  }
}
