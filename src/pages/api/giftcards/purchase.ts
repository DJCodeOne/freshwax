// src/pages/api/giftcards/purchase.ts
// Purchase a gift card and email the code to recipient

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, addDocument, queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

// Send email via Resend API (using fetch for Cloudflare compatibility)
async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const RESEND_API_KEY = import.meta.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.error('[giftcards/purchase] No Resend API key configured');
    return false;
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Fresh Wax <noreply@freshwax.co.uk>',
        to,
        subject,
        html
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[giftcards/purchase] Resend error:', response.status, error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[giftcards/purchase] Email send error:', error);
    return false;
  }
}

// Generate gift card code
function generateGiftCardCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing chars
  let code = 'FWGC-';
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (i < 2) code += '-';
  }
  return code;
}

// Send gift card email
async function sendGiftCardEmail(
  toEmail: string,
  toName: string,
  code: string,
  amount: number,
  isGift: boolean,
  senderName: string,
  message: string
): Promise<boolean> {
  try {
    const subject = isGift
      ? `🎁 You've received a £${amount} Fresh Wax Gift Card!`
      : `🎁 Your £${amount} Fresh Wax Gift Card`;

    const giftSection = isGift && senderName ? `
      <p style="font-size: 16px; color: #666;">
        <strong>${senderName}</strong> has sent you a gift!
      </p>
      ${message ? `
      <div style="background: #f5f5f5; border-left: 4px solid #dc2626; padding: 15px 20px; margin: 20px 0; border-radius: 0 8px 8px 0;">
        <p style="font-size: 16px; color: #333; margin: 0; font-style: italic;">"${message}"</p>
      </div>
      ` : ''}
    ` : '';

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="background: #ffffff; padding: 30px; text-align: center; border-bottom: 3px solid #dc2626;">
              <h1 style="margin: 0; font-size: 32px; color: #000; font-weight: 700;">
                Fresh <span style="color: #dc2626;">Wax</span>
              </h1>
              <p style="margin: 10px 0 0 0; color: #888; font-size: 14px;">Underground Music Store</p>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">
              <div style="text-align: center; margin-bottom: 30px;">
                <!-- Gift Box Icon -->
                <table cellpadding="0" cellspacing="0" border="0" align="center" style="margin: 0 auto;">
                  <!-- Bow loops -->
                  <tr>
                    <td align="center" style="padding-bottom: 0;">
                      <table cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <td style="width: 18px; height: 14px; background: #dc2626; border-radius: 50%;"></td>
                          <td style="width: 8px;"></td>
                          <td style="width: 18px; height: 14px; background: #dc2626; border-radius: 50%;"></td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <!-- Bow center -->
                  <tr>
                    <td align="center" style="padding-bottom: 2px;">
                      <div style="width: 12px; height: 12px; background: #b91c1c; border-radius: 50%; margin: 0 auto;"></div>
                    </td>
                  </tr>
                  <!-- Lid with ribbon -->
                  <tr>
                    <td align="center">
                      <table cellpadding="0" cellspacing="0" border="0" style="background: #ef4444; border-radius: 4px;">
                        <tr>
                          <td style="width: 25px; height: 14px;"></td>
                          <td style="width: 14px; height: 14px; background: #fbbf24;"></td>
                          <td style="width: 25px; height: 14px;"></td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <!-- Box body with ribbon -->
                  <tr>
                    <td align="center">
                      <table cellpadding="0" cellspacing="0" border="0" style="background: #dc2626; border-radius: 0 0 4px 4px;">
                        <tr>
                          <td style="width: 23px; height: 40px;"></td>
                          <td style="width: 14px; height: 40px; background: #fbbf24;"></td>
                          <td style="width: 23px; height: 40px;"></td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </div>

              <h2 style="font-size: 28px; color: #111; text-align: center; margin: 0 0 20px 0;">
                ${isGift ? 'You\'ve Received a Gift Card!' : 'Your Gift Card is Ready!'}
              </h2>

              ${giftSection}

              <!-- Gift Card Box -->
              <div style="background: linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 100%); border-radius: 16px; padding: 30px; text-align: center; margin: 30px 0;">
                <p style="color: #888; font-size: 14px; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 10px 0;">Gift Card Value</p>
                <p style="font-size: 48px; color: #dc2626; font-weight: 700; margin: 0 0 20px 0;">£${amount}</p>

                <p style="color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 10px 0;">Your Redemption Code</p>
                <div style="background: #111; border: 2px solid #dc2626; border-radius: 10px; padding: 15px 25px; display: inline-block;">
                  <code style="font-size: 24px; color: #fff; letter-spacing: 3px; font-family: 'Monaco', 'Consolas', monospace;">${code}</code>
                </div>
              </div>

              <!-- How to Use -->
              <div style="background: #f9f9f9; border-radius: 12px; padding: 25px; margin: 30px 0;">
                <h3 style="font-size: 18px; color: #111; margin: 0 0 15px 0;">How to Redeem</h3>
                <ol style="color: #666; font-size: 15px; line-height: 1.8; margin: 0; padding-left: 20px;">
                  <li>Visit <a href="https://freshwax.co.uk/giftcards" style="color: #dc2626;">freshwax.co.uk/giftcards</a></li>
                  <li>Sign in or create an account</li>
                  <li>Enter your code above</li>
                  <li>Start shopping!</li>
                </ol>
              </div>

              <!-- CTA Button -->
              <div style="text-align: center; margin: 30px 0;">
                <a href="https://freshwax.co.uk/giftcards" style="display: inline-block; background: #dc2626; color: #fff; text-decoration: none; padding: 16px 40px; border-radius: 10px; font-size: 16px; font-weight: 600;">
                  Redeem Your Gift Card →
                </a>
              </div>

              <p style="color: #888; font-size: 13px; text-align: center; margin: 30px 0 0 0;">
                Your gift card credit expires 1 year from redemption. Use it to buy digital releases, vinyl records, and merchandise.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background: #f5f5f5; padding: 25px 30px; text-align: center; border-top: 1px solid #eee;">
              <p style="color: #888; font-size: 13px; margin: 0;">
                <span style="color: #000;">Fresh</span> <span style="color: #dc2626;">Wax</span> - Underground Jungle & Drum and Bass<br>
                <a href="https://freshwax.co.uk" style="color: #dc2626;">freshwax.co.uk</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `;

    const sent = await sendEmail(toEmail, subject, html);

    if (sent) {
      console.log(`[giftcards/purchase] Email sent to ${toEmail}`);
    }
    return sent;
  } catch (error) {
    console.error('[giftcards/purchase] Email error:', error);
    return false;
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  initFirebase(locals);

  try {
    const data = await request.json();
    const {
      amount,
      buyerUserId,
      buyerEmail,
      recipientType,
      recipientName,
      recipientEmail,
      message
    } = data;

    // Validate amount
    const numAmount = parseInt(amount);
    if (!numAmount || numAmount < 5 || numAmount > 500) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid amount. Must be between £5 and £500.'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate buyer
    if (!buyerUserId || !buyerEmail) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Must be logged in to purchase'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate recipient email
    const targetEmail = recipientType === 'gift' ? recipientEmail : buyerEmail;
    if (!targetEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid recipient email address'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Generate unique code
    let code = generateGiftCardCode();

    // Ensure code is unique
    let attempts = 0;
    while (attempts < 10) {
      const existing = await queryCollection('giftCards', {
        filters: [{ field: 'code', op: 'EQUAL', value: code }],
        limit: 1
      });

      if (existing.length === 0) break;
      code = generateGiftCardCode();
      attempts++;
    }

    // Get buyer name
    let buyerName = '';
    try {
      const buyerDoc = await getDocument('customers', buyerUserId);
      if (buyerDoc) {
        buyerName = buyerDoc.displayName || buyerDoc.fullName || buyerDoc.firstName || '';
      }
    } catch (e) {
      // Ignore
    }

    const now = new Date();
    const purchasedAt = now.toISOString();

    // Calculate expiry (1 year from purchase for display, but actually expires 1 year from redemption)
    const displayExpiryDate = new Date(now);
    displayExpiryDate.setFullYear(displayExpiryDate.getFullYear() + 1);
    const displayExpiresAt = displayExpiryDate.toISOString();

    // Create gift card document
    const giftCard = {
      code,
      originalValue: numAmount,
      currentBalance: numAmount,
      type: recipientType === 'gift' ? 'gift' : 'purchased',
      description: recipientType === 'gift'
        ? `Gift card from ${buyerName || buyerEmail}`
        : 'Purchased gift card',
      createdAt: purchasedAt,
      expiresAt: null, // Actual expiry set on redemption
      isActive: true,
      redeemedBy: null,
      redeemedAt: null,

      // Purchase info
      purchasedBy: buyerUserId,
      purchasedByEmail: buyerEmail,
      purchasedByName: buyerName,
      recipientEmail: targetEmail,
      recipientName: recipientName || '',
      giftMessage: message || '',

      // Email tracking
      emailsSent: []
    };

    const giftCardResult = await addDocument('giftCards', giftCard);
    console.log(`[giftcards/purchase] Created gift card ${code} for £${numAmount}`);

    // Store purchase record in customer's account
    const purchaseRecord = {
      giftCardId: giftCardResult.id,
      amount: numAmount,
      recipientEmail: targetEmail,
      recipientName: recipientName || '',
      recipientType,
      purchasedAt,
      displayExpiresAt,
      status: 'sent'
    };

    // Note: Firebase REST API doesn't support subcollections directly via addDocument
    // We'll use a workaround by creating a document with a generated ID
    const purchaseRecordId = `purchase_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await fetch(
      `https://firestore.googleapis.com/v1/projects/freshwax-store/databases/(default)/documents/customers/${buyerUserId}/purchasedGiftCards?documentId=${purchaseRecordId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            giftCardId: { stringValue: giftCardResult.id },
            amount: { integerValue: String(numAmount) },
            recipientEmail: { stringValue: targetEmail },
            recipientName: { stringValue: recipientName || '' },
            recipientType: { stringValue: recipientType },
            purchasedAt: { stringValue: purchasedAt },
            displayExpiresAt: { stringValue: displayExpiresAt },
            status: { stringValue: 'sent' }
          }
        })
      }
    );
    console.log(`[giftcards/purchase] Added purchase record to customer ${buyerUserId}`);

    // Send email to recipient
    const isGift = recipientType === 'gift';
    const recipientEmailSent = await sendGiftCardEmail(
      targetEmail,
      recipientName || '',
      code,
      numAmount,
      isGift,
      buyerName,
      message || ''
    );

    // Update email tracking
    if (recipientEmailSent) {
      await updateDocument('giftCards', giftCardResult.id, {
        emailsSent: [
          { email: targetEmail, sentAt: new Date().toISOString(), type: 'recipient' }
        ]
      });
    }

    return new Response(JSON.stringify({
      success: true,
      giftCard: {
        code,
        amount: numAmount,
        recipientEmail: targetEmail,
        purchasedAt,
        expiresAt: displayExpiresAt
      },
      emailSent: recipientEmailSent
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[giftcards/purchase] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to create gift card'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
