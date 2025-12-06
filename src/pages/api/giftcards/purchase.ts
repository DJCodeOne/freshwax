// src/pages/api/giftcards/purchase.ts
// Purchase a gift card and email the code to recipient

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { Resend } from 'resend';

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

// Initialize Resend for emails
const resend = new Resend(import.meta.env.RESEND_API_KEY);
const FROM_EMAIL = 'Fresh Wax <noreply@freshwax.co.uk>';

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
            <td style="background: linear-gradient(135deg, #1a1a1a 0%, #000 100%); padding: 30px; text-align: center;">
              <h1 style="margin: 0; font-size: 32px; color: #fff; font-weight: 400;">
                Fresh <span style="color: #dc2626;">Wax</span>
              </h1>
              <p style="margin: 10px 0 0 0; color: #888; font-size: 14px;">Underground Music Store</p>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">
              <div style="text-align: center; margin-bottom: 30px;">
                <span style="font-size: 60px;">🎁</span>
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
                Your gift card credit never expires. Use it to buy digital releases, vinyl records, merchandise, and DJ mixes.
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background: #f5f5f5; padding: 25px 30px; text-align: center; border-top: 1px solid #eee;">
              <p style="color: #888; font-size: 13px; margin: 0;">
                Fresh Wax - Underground Jungle & Drum and Bass<br>
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
    
    await resend.emails.send({
      from: FROM_EMAIL,
      to: toEmail,
      subject,
      html
    });
    
    console.log(`[giftcards/purchase] Email sent to ${toEmail}`);
    return true;
  } catch (error) {
    console.error('[giftcards/purchase] Email error:', error);
    return false;
  }
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const data = await request.json();
    const {
      amount,
      buyerUserId,
      buyerEmail,
      recipientType,
      recipientName,
      recipientEmail,
      message,
      sendCopyToMe
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
      const existing = await db.collection('giftCards')
        .where('code', '==', code)
        .get();
      
      if (existing.empty) break;
      code = generateGiftCardCode();
      attempts++;
    }
    
    // Get buyer name
    let buyerName = '';
    try {
      const buyerDoc = await db.collection('customers').doc(buyerUserId).get();
      if (buyerDoc.exists) {
        const buyerData = buyerDoc.data();
        buyerName = buyerData?.displayName || buyerData?.fullName || buyerData?.firstName || '';
      }
    } catch (e) {
      // Ignore
    }
    
    // Create gift card document
    const giftCard = {
      code,
      originalValue: numAmount,
      currentBalance: numAmount,
      type: recipientType === 'gift' ? 'gift' : 'purchased',
      description: recipientType === 'gift' 
        ? `Gift card from ${buyerName || buyerEmail}` 
        : 'Purchased gift card',
      createdAt: new Date().toISOString(),
      expiresAt: null, // Gift cards don't expire
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
    
    await db.collection('giftCards').add(giftCard);
    console.log(`[giftcards/purchase] Created gift card ${code} for £${numAmount}`);
    
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
      await db.collection('giftCards')
        .where('code', '==', code)
        .get()
        .then(snapshot => {
          snapshot.forEach(doc => {
            doc.ref.update({
              emailsSent: [
                { email: targetEmail, sentAt: new Date().toISOString(), type: 'recipient' }
              ]
            });
          });
        });
    }
    
    // Send copy to buyer if requested (and it's a gift)
    if (isGift && sendCopyToMe && buyerEmail !== targetEmail) {
      await sendGiftCardEmail(
        buyerEmail,
        buyerName,
        code,
        numAmount,
        false, // Not a gift when sending to self
        '',
        ''
      );
    }
    
    return new Response(JSON.stringify({
      success: true,
      giftCard: {
        code,
        amount: numAmount,
        recipientEmail: targetEmail
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
