// src/lib/abandoned-cart-email.ts
// Sends abandoned cart recovery emails when Stripe checkout sessions expire

// SECURITY: Escape user-supplied data for safe HTML embedding
function esc(s: string | null | undefined): string {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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
  env: any
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    if (!email) {
      // console.log('[Abandoned Cart] No email address, skipping');
      return { success: false, error: 'No email address' };
    }

    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (!RESEND_API_KEY) {
      // console.log('[Abandoned Cart] No Resend API key configured, skipping');
      return { success: false, error: 'Email service not configured' };
    }

    const formattedTotal = `£${total.toFixed(2)}`;
    const greeting = name ? esc(name.split(' ')[0]) : 'there';
    const cartUrl = 'https://freshwax.co.uk/cart/';
    const unsubUrl = 'https://freshwax.co.uk/account/settings/';

    // Build items table rows
    const itemRows = items.map(item => {
      const itemName = esc(item.name || item.title || 'Item');
      const qty = item.quantity || 1;
      const price = (item.price || 0) * qty;
      const imgSrc = item.image || item.artwork || 'https://freshwax.co.uk/logo.webp';

      return `
                      <tr>
                        <td style="padding: 12px 0; border-bottom: 1px solid #262626;">
                          <table cellpadding="0" cellspacing="0" width="100%">
                            <tr>
                              <td width="60" style="vertical-align: top;">
                                <img src="${esc(imgSrc)}" alt="" width="50" height="50" style="border-radius: 6px; object-fit: cover; display: block;" />
                              </td>
                              <td style="vertical-align: top; padding-left: 12px;">
                                <p style="color: #ffffff; font-size: 14px; font-weight: 600; margin: 0 0 4px;">${itemName}</p>
                                <p style="color: #737373; font-size: 13px; margin: 0;">Qty: ${qty}</p>
                              </td>
                              <td width="80" align="right" style="vertical-align: top;">
                                <p style="color: #ffffff; font-size: 14px; font-weight: 600; margin: 0;">£${price.toFixed(2)}</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>`;
    }).join('');

    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You left something behind!</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #141414; border-radius: 12px; overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%); padding: 40px 40px 30px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700;">
                You left something behind!
              </h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;">
                Hey ${greeting},
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 25px; line-height: 1.6;">
                Looks like you didn't finish checking out. Your items are still waiting for you.
              </p>

              <!-- Items Table -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #1f1f1f; border-radius: 8px; margin-bottom: 25px;">
                <tr>
                  <td style="padding: 16px 20px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      ${itemRows}
                      <tr>
                        <td colspan="3" style="padding-top: 16px;">
                          <table width="100%" cellpadding="0" cellspacing="0">
                            <tr>
                              <td style="color: #a3a3a3; font-size: 14px; font-weight: 600;">Total</td>
                              <td align="right" style="color: #dc2626; font-size: 18px; font-weight: 700;">${formattedTotal}</td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 10px 0 30px;">
                    <a href="${cartUrl}" style="display: inline-block; background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%); color: #ffffff; text-decoration: none; padding: 16px 40px; border-radius: 8px; font-weight: 700; font-size: 16px; letter-spacing: 0.5px;">
                      COMPLETE YOUR ORDER
                    </a>
                  </td>
                </tr>
              </table>

              <p style="color: #737373; font-size: 13px; margin: 0; line-height: 1.6;">
                Questions? Just reply to this email and we'll help you out.
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
                    <a href="https://freshwax.co.uk" style="text-decoration: none; font-size: 13px; color: #ffffff;">freshwax.co.uk</a>
                  </td>
                </tr>
                <tr>
                  <td colspan="2" style="padding-top: 12px;">
                    <a href="${unsubUrl}" style="font-size: 11px; color: #525252; text-decoration: underline;">
                      Manage email preferences
                    </a>
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

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Fresh Wax <noreply@freshwax.co.uk>',
        to: email,
        subject: `You left ${items.length === 1 ? 'an item' : 'items'} in your cart - Fresh Wax`,
        html: emailHtml
      })
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('[Abandoned Cart] Resend error:', result);
      return { success: false, error: result.message || 'Failed to send email' };
    }

    // console.log('[Abandoned Cart] Recovery email sent to:', email);
    return { success: true, messageId: result.id };

  } catch (error) {
    console.error('[Abandoned Cart] Error sending recovery email:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}
