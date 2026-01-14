// src/pages/api/stripe/webhook.ts
// Handles Stripe webhook events for product checkouts

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { createOrder } from '../../../lib/order-utils';
import { initFirebaseEnv, getDocument, queryCollection, deleteDocument, addDocument, updateDocument } from '../../../lib/firebase-rest';
import { logStripeEvent } from '../../../lib/webhook-logger';
import { createPayout as createPayPalPayout, getPayPalConfig } from '../../../lib/paypal-payouts';
import { redeemReferralCode } from '../../../lib/referral-codes';
import { createGiftCardAfterPayment } from '../../../lib/giftcard';
import { recordMultiSellerSale } from '../../../lib/sales-ledger';

export const prerender = false;

// Stripe webhook signature verification
async function verifyStripeSignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  try {
    // Parse the signature header
    const parts = signature.split(',');
    const timestamp = parts.find(p => p.startsWith('t='))?.split('=')[1];
    const v1Signature = parts.find(p => p.startsWith('v1='))?.split('=')[1];

    if (!timestamp || !v1Signature) {
      console.error('[Stripe Webhook] Missing signature components');
      return false;
    }

    // Check timestamp is within tolerance (5 minutes)
    const currentTime = Math.floor(Date.now() / 1000);
    if (Math.abs(currentTime - parseInt(timestamp)) > 300) {
      console.error('[Stripe Webhook] Timestamp too old');
      return false;
    }

    // Compute expected signature
    const signedPayload = `${timestamp}.${payload}`;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const messageData = encoder.encode(signedPayload);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signatureBytes = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    const expectedSignature = Array.from(new Uint8Array(signatureBytes))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    return expectedSignature === v1Signature;
  } catch (error) {
    console.error('[Stripe Webhook] Signature verification error:', error);
    return false;
  }
}

// Send email notification about pending earnings to artists without Stripe Connect
async function sendPendingEarningsEmail(
  artistEmail: string,
  artistName: string,
  amount: number,
  env: any
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    if (!artistEmail) {
      console.log('[Stripe Webhook] No email address for artist, skipping notification');
      return { success: false, error: 'No email address' };
    }

    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (!RESEND_API_KEY) {
      console.log('[Stripe Webhook] No Resend API key configured, skipping email');
      return { success: false, error: 'Email service not configured' };
    }

    const connectUrl = 'https://freshwax.co.uk/artist/account?setup=stripe';
    const formattedAmount = `£${amount.toFixed(2)}`;

    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You've got earnings waiting!</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #141414; border-radius: 12px; overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); padding: 40px 40px 30px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700;">
                💰 You've Made a Sale!
              </h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;">
                Hey ${artistName || 'there'},
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 25px; line-height: 1.6;">
                Great news! Someone just purchased your music on Fresh Wax. You've earned <strong style="color: #22c55e;">${formattedAmount}</strong> from this sale.
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 30px; line-height: 1.6;">
                To receive your payment, you need to connect your Stripe account. It only takes a few minutes and allows us to pay you directly.
              </p>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 10px 0 30px;">
                    <a href="${connectUrl}" style="display: inline-block; background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); color: #ffffff; text-decoration: none; padding: 16px 40px; border-radius: 8px; font-weight: 600; font-size: 16px;">
                      Connect Stripe & Get Paid →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="color: #737373; font-size: 14px; margin: 0 0 15px; line-height: 1.6;">
                Your earnings are held securely and will be transferred as soon as you connect your account.
              </p>

              <p style="color: #a3a3a3; font-size: 14px; margin: 0; line-height: 1.6;">
                If you have any questions, just reply to this email.
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
        to: artistEmail,
        subject: `💰 You've made a sale on Fresh Wax! Connect Stripe to get paid`,
        html: emailHtml
      })
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('[Stripe Webhook] Resend error:', result);
      return { success: false, error: result.message || 'Failed to send email' };
    }

    console.log('[Stripe Webhook] Pending earnings email sent to:', artistEmail);
    return { success: true, messageId: result.id };

  } catch (error) {
    console.error('[Stripe Webhook] Error sending pending earnings email:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// Send email notification when a payout is completed to an artist
async function sendPayoutCompletedEmail(
  artistEmail: string,
  artistName: string,
  amount: number,
  orderNumber: string,
  env: any
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    if (!artistEmail) {
      console.log('[Stripe Webhook] No email address for artist, skipping payout notification');
      return { success: false, error: 'No email address' };
    }

    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (!RESEND_API_KEY) {
      console.log('[Stripe Webhook] No Resend API key configured, skipping payout email');
      return { success: false, error: 'Email service not configured' };
    }

    const dashboardUrl = 'https://freshwax.co.uk/artist/payouts';
    const formattedAmount = `£${amount.toFixed(2)}`;

    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Sent!</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #141414; border-radius: 12px; overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); padding: 40px 40px 30px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700;">
                ✅ Payment Sent!
              </h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;">
                Hey ${artistName || 'there'},
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 25px; line-height: 1.6;">
                We've just sent <strong style="color: #22c55e;">${formattedAmount}</strong> to your connected Stripe account from order <strong style="color: #ffffff;">#${orderNumber}</strong>.
              </p>

              <!-- Payment Details Box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #1f1f1f; border-radius: 8px; margin-bottom: 25px;">
                <tr>
                  <td style="padding: 20px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="color: #737373; font-size: 14px; padding-bottom: 10px;">Amount</td>
                        <td align="right" style="color: #22c55e; font-size: 18px; font-weight: 700; padding-bottom: 10px;">${formattedAmount}</td>
                      </tr>
                      <tr>
                        <td style="color: #737373; font-size: 14px;">Order</td>
                        <td align="right" style="color: #ffffff; font-size: 14px;">#${orderNumber}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="color: #a3a3a3; font-size: 14px; margin: 0 0 25px; line-height: 1.6;">
                The funds will appear in your Stripe balance shortly and will be transferred to your bank account according to your payout schedule.
              </p>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 10px 0 30px;">
                    <a href="${dashboardUrl}" style="display: inline-block; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 14px;">
                      View Payout History →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="color: #737373; font-size: 13px; margin: 0; line-height: 1.6;">
                Thanks for being part of Fresh Wax!
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
        to: artistEmail,
        subject: `✅ ${formattedAmount} payment sent to your account - Order #${orderNumber}`,
        html: emailHtml
      })
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('[Stripe Webhook] Resend error (payout email):', result);
      return { success: false, error: result.message || 'Failed to send email' };
    }

    console.log('[Stripe Webhook] Payout completed email sent to:', artistEmail);
    return { success: true, messageId: result.id };

  } catch (error) {
    console.error('[Stripe Webhook] Error sending payout completed email:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// Send email notification when a refund affects artist earnings
async function sendRefundNotificationEmail(
  artistEmail: string,
  artistName: string,
  refundAmount: number,
  originalPayout: number,
  orderNumber: string,
  isFullRefund: boolean,
  env: any
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    if (!artistEmail) {
      console.log('[Stripe Webhook] No email address for artist, skipping refund notification');
      return { success: false, error: 'No email address' };
    }

    const RESEND_API_KEY = env?.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;

    if (!RESEND_API_KEY) {
      console.log('[Stripe Webhook] No Resend API key configured, skipping refund email');
      return { success: false, error: 'Email service not configured' };
    }

    const dashboardUrl = 'https://freshwax.co.uk/artist/payouts';
    const formattedRefund = `£${refundAmount.toFixed(2)}`;
    const formattedOriginal = `£${originalPayout.toFixed(2)}`;

    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Refund Processed</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #141414; border-radius: 12px; overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 40px 40px 30px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700;">
                ↩️ Refund Adjustment
              </h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <p style="color: #ffffff; font-size: 18px; margin: 0 0 20px; line-height: 1.6;">
                Hey ${artistName || 'there'},
              </p>

              <p style="color: #a3a3a3; font-size: 16px; margin: 0 0 25px; line-height: 1.6;">
                A customer requested a ${isFullRefund ? 'full' : 'partial'} refund for order <strong style="color: #ffffff;">#${orderNumber}</strong>. As a result, your earnings have been adjusted.
              </p>

              <!-- Refund Details Box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #1f1f1f; border-radius: 8px; margin-bottom: 25px;">
                <tr>
                  <td style="padding: 20px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="color: #737373; font-size: 14px; padding-bottom: 10px;">Original Payout</td>
                        <td align="right" style="color: #ffffff; font-size: 16px; padding-bottom: 10px;">${formattedOriginal}</td>
                      </tr>
                      <tr>
                        <td style="color: #737373; font-size: 14px; padding-bottom: 10px;">Refund Amount</td>
                        <td align="right" style="color: #ef4444; font-size: 16px; padding-bottom: 10px;">-${formattedRefund}</td>
                      </tr>
                      <tr style="border-top: 1px solid #333;">
                        <td style="color: #737373; font-size: 14px; padding-top: 10px;">Net Change</td>
                        <td align="right" style="color: ${isFullRefund ? '#ef4444' : '#f59e0b'}; font-size: 18px; font-weight: 700; padding-top: 10px;">-${formattedRefund}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="color: #a3a3a3; font-size: 14px; margin: 0 0 25px; line-height: 1.6;">
                ${isFullRefund
                  ? 'The full payout amount has been reversed from your Stripe balance.'
                  : 'A proportional amount has been reversed from your Stripe balance based on the refund percentage.'
                }
              </p>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 10px 0 30px;">
                    <a href="${dashboardUrl}" style="display: inline-block; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 14px;">
                      View Payout History →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="color: #737373; font-size: 13px; margin: 0; line-height: 1.6;">
                Questions? Reply to this email and we'll help you out.
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
        to: artistEmail,
        subject: `↩️ Refund adjustment: -${formattedRefund} from order #${orderNumber}`,
        html: emailHtml
      })
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('[Stripe Webhook] Resend error (refund email):', result);
      return { success: false, error: result.message || 'Failed to send email' };
    }

    console.log('[Stripe Webhook] Refund notification email sent to:', artistEmail);
    return { success: true, messageId: result.id };

  } catch (error) {
    console.error('[Stripe Webhook] Error sending refund notification email:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  const startTime = Date.now();
  console.log('[Stripe Webhook] ========== WEBHOOK REQUEST RECEIVED ==========');
  console.log('[Stripe Webhook] Timestamp:', new Date().toISOString());

  try {
    const env = (locals as any)?.runtime?.env;

    // Get webhook secret
    const webhookSecret = env?.STRIPE_WEBHOOK_SECRET || import.meta.env.STRIPE_WEBHOOK_SECRET;
    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;

    console.log('[Stripe Webhook] Environment check:');
    console.log('[Stripe Webhook]   - webhookSecret exists:', !!webhookSecret);
    console.log('[Stripe Webhook]   - stripeSecretKey exists:', !!stripeSecretKey);
    console.log('[Stripe Webhook]   - env from locals:', !!env);

    // Initialize Firebase
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
    const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

    console.log('[Stripe Webhook]   - Firebase projectId:', projectId || 'MISSING');
    console.log('[Stripe Webhook]   - Firebase apiKey exists:', !!apiKey);

    initFirebaseEnv({
      FIREBASE_PROJECT_ID: projectId,
      FIREBASE_API_KEY: apiKey,
    });

    // Get raw body for signature verification
    const payload = await request.text();
    const signature = request.headers.get('stripe-signature');

    console.log('[Stripe Webhook] Request details:');
    console.log('[Stripe Webhook]   - Payload length:', payload.length);
    console.log('[Stripe Webhook]   - Signature exists:', !!signature);
    console.log('[Stripe Webhook]   - Signature preview:', signature ? signature.substring(0, 50) + '...' : 'none');

    // SECURITY: Signature verification is REQUIRED in production
    // Only skip in development if explicitly configured
    const isDevelopment = import.meta.env.DEV;

    if (!signature) {
      console.error('[Stripe Webhook] ❌ Missing signature header - REJECTING REQUEST');
      return new Response(JSON.stringify({ error: 'Missing signature' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (webhookSecret) {
      console.log('[Stripe Webhook] Verifying signature...');
      const isValid = await verifyStripeSignature(payload, signature, webhookSecret);
      if (!isValid) {
        console.error('[Stripe Webhook] ❌ Invalid signature - REJECTING REQUEST');
        return new Response(JSON.stringify({ error: 'Invalid signature' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      console.log('[Stripe Webhook] ✓ Signature verified successfully');
    } else if (!isDevelopment) {
      // In production, REQUIRE webhook secret
      console.error('[Stripe Webhook] ❌ SECURITY: Webhook secret not configured in production - REJECTING');
      return new Response(JSON.stringify({ error: 'Webhook not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    } else {
      console.log('[Stripe Webhook] ⚠️ DEV MODE: Skipping signature verification');
    }

    const event = JSON.parse(payload);
    console.log('[Stripe Webhook] Event type:', event.type);
    console.log('[Stripe Webhook] Event ID:', event.id || 'no-id');

    // Handle checkout.session.completed event
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log('[Stripe Webhook] ========== CHECKOUT SESSION COMPLETED ==========');
      console.log('[Stripe Webhook] Session ID:', session.id);
      console.log('[Stripe Webhook] Payment status:', session.payment_status);
      console.log('[Stripe Webhook] Payment intent:', session.payment_intent);
      console.log('[Stripe Webhook] Mode:', session.mode);
      console.log('[Stripe Webhook] Amount total:', session.amount_total);
      console.log('[Stripe Webhook] Currency:', session.currency);

      // Handle Plus subscription
      if (session.mode === 'subscription') {
        console.log('[Stripe Webhook] 👑 Processing Plus subscription...');

        const metadata = session.metadata || {};
        const userId = metadata.userId;
        const email = session.customer_email || metadata.email;

        if (userId) {
          // Calculate subscription dates
          const subscribedAt = new Date().toISOString();
          const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(); // 1 year

          // Generate Plus ID
          const year = new Date().getFullYear().toString().slice(-2);
          const month = (new Date().getMonth() + 1).toString().padStart(2, '0');
          const userHash = userId.slice(-4).toUpperCase();
          const plusId = `FWP-${year}${month}-${userHash}`;

          // Update user subscription in Firestore
          const FIREBASE_PROJECT_ID = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
          const FIREBASE_API_KEY = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

          const updateData = {
            fields: {
              'subscription': {
                mapValue: {
                  fields: {
                    tier: { stringValue: 'pro' },
                    subscribedAt: { stringValue: subscribedAt },
                    expiresAt: { stringValue: expiresAt },
                    subscriptionId: { stringValue: session.subscription || session.id },
                    plusId: { stringValue: plusId },
                    paymentMethod: { stringValue: 'stripe' }
                  }
                }
              }
            }
          };

          try {
            const updateResponse = await fetch(
              `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}?updateMask.fieldPaths=subscription&key=${FIREBASE_API_KEY}`,
              {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updateData)
              }
            );

            if (updateResponse.ok) {
              console.log('[Stripe Webhook] ✓ User subscription updated:', userId);

              // Send welcome email
              try {
                const origin = new URL(request.url).origin;
                await fetch(`${origin}/api/admin/send-plus-welcome-email`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    email: email,
                    name: metadata.userName || email?.split('@')[0],
                    subscribedAt,
                    expiresAt,
                    plusId,
                    isRenewal: false
                  })
                });
                console.log('[Stripe Webhook] ✓ Welcome email sent to:', email);

                // Mark referral code as redeemed if one was used
                const referralCardId = metadata.referralCardId;
                const isKvCode = metadata.isKvCode === 'true';
                const promoCodeUsed = metadata.promoCode;

                if (isKvCode && promoCodeUsed) {
                  // New KV-based referral code system
                  try {
                    const kv = env?.CACHE as KVNamespace | undefined;
                    if (kv) {
                      const result = await redeemReferralCode(kv, promoCodeUsed, userId);
                      if (result.success) {
                        console.log(`[Stripe Webhook] ✓ KV referral code ${promoCodeUsed} marked as redeemed by ${userId}`);
                      } else {
                        console.error('[Stripe Webhook] KV referral redemption error:', result.error);
                      }
                    }
                  } catch (referralError) {
                    console.error('[Stripe Webhook] Failed to mark KV referral code as redeemed:', referralError);
                  }
                } else if (referralCardId) {
                  // Legacy Firebase giftCards system
                  try {
                    const redeemData = {
                      fields: {
                        redeemedBy: { stringValue: userId },
                        redeemedAt: { stringValue: new Date().toISOString() },
                        isActive: { booleanValue: false }
                      }
                    };

                    await fetch(
                      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/giftCards/${referralCardId}?updateMask.fieldPaths=redeemedBy&updateMask.fieldPaths=redeemedAt&updateMask.fieldPaths=isActive&key=${FIREBASE_API_KEY}`,
                      {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(redeemData)
                      }
                    );
                    console.log(`[Stripe Webhook] ✓ Firebase referral code ${referralCardId} marked as redeemed by ${userId}`);
                  } catch (referralError) {
                    console.error('[Stripe Webhook] Failed to mark Firebase referral code as redeemed:', referralError);
                  }
                }

                // Log successful subscription
                logStripeEvent(event.type, event.id, true, {
                  message: `Plus subscription activated for ${userId}`,
                  metadata: { userId, plusId, promoCode: promoCode || null },
                  processingTimeMs: Date.now() - startTime
                }).catch(() => {});
              } catch (emailError) {
                console.error('[Stripe Webhook] Failed to send welcome email:', emailError);
              }
            } else {
              console.error('[Stripe Webhook] Failed to update user subscription');
              logStripeEvent(event.type, event.id, false, {
                message: 'Failed to update user subscription',
                error: 'Firestore update failed'
              }).catch(() => {});
            }
          } catch (updateError) {
            console.error('[Stripe Webhook] Error updating subscription:', updateError);
            logStripeEvent(event.type, event.id, false, {
              message: 'Error updating subscription',
              error: updateError instanceof Error ? updateError.message : 'Unknown error'
            }).catch(() => {});
          }
        }

        return new Response(JSON.stringify({ received: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Handle one-off Plus payment (promo code purchases)
      if (session.mode === 'payment') {
        const metadata = session.metadata || {};

        // Check if this is a Plus subscription payment (promo)
        if (metadata.type === 'plus_subscription') {
          console.log('[Stripe Webhook] 👑 Processing Plus one-off payment (promo)...');

          const userId = metadata.userId;
          const email = session.customer_email || metadata.email;
          const promoCode = metadata.promoCode;

          if (userId) {
            // Calculate subscription dates
            const subscribedAt = new Date().toISOString();
            const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(); // 1 year

            // Generate Plus ID
            const year = new Date().getFullYear().toString().slice(-2);
            const month = (new Date().getMonth() + 1).toString().padStart(2, '0');
            const userHash = userId.slice(-4).toUpperCase();
            const plusId = `FWP-${year}${month}-${userHash}`;

            // Update user subscription in Firestore
            const FIREBASE_PROJECT_ID = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
            const FIREBASE_API_KEY = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

            const updateData = {
              fields: {
                'subscription': {
                  mapValue: {
                    fields: {
                      tier: { stringValue: 'pro' },
                      subscribedAt: { stringValue: subscribedAt },
                      expiresAt: { stringValue: expiresAt },
                      subscriptionId: { stringValue: session.payment_intent || session.id },
                      plusId: { stringValue: plusId },
                      paymentMethod: { stringValue: 'stripe' },
                      promoCode: { stringValue: promoCode || '' }
                    }
                  }
                }
              }
            };

            try {
              const updateResponse = await fetch(
                `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}?updateMask.fieldPaths=subscription&key=${FIREBASE_API_KEY}`,
                {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(updateData)
                }
              );

              if (updateResponse.ok) {
                console.log('[Stripe Webhook] ✓ User Plus subscription activated (promo):', userId);

                // Send welcome email
                try {
                  const origin = new URL(request.url).origin;
                  await fetch(`${origin}/api/admin/send-plus-welcome-email`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      email: email,
                      name: metadata.userName || email?.split('@')[0],
                      subscribedAt,
                      expiresAt,
                      plusId,
                      isRenewal: false
                    })
                  });
                  console.log('[Stripe Webhook] ✓ Welcome email sent to:', email);
                } catch (emailError) {
                  console.error('[Stripe Webhook] Failed to send welcome email:', emailError);
                }

                // Mark referral code as redeemed
                const referralCardId = metadata.referralCardId;
                const isKvCode = metadata.isKvCode === 'true';

                if (isKvCode && promoCode) {
                  // Redeem KV-based referral code
                  try {
                    const kv = env?.CACHE as KVNamespace | undefined;
                    if (kv) {
                      const result = await redeemReferralCode(kv, promoCode, userId);
                      if (result.success) {
                        console.log(`[Stripe Webhook] ✓ KV referral code ${promoCode} marked as redeemed by ${userId}`);
                      } else {
                        console.error(`[Stripe Webhook] Failed to redeem KV code: ${result.error}`);
                      }
                    }
                  } catch (referralError) {
                    console.error('[Stripe Webhook] Failed to mark KV referral code as redeemed:', referralError);
                  }
                } else if (referralCardId) {
                  // Redeem Firebase-based referral code (legacy)
                  try {
                    const redeemData = {
                      fields: {
                        redeemedBy: { stringValue: userId },
                        redeemedAt: { stringValue: new Date().toISOString() },
                        isActive: { booleanValue: false }
                      }
                    };

                    await fetch(
                      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/giftCards/${referralCardId}?updateMask.fieldPaths=redeemedBy&updateMask.fieldPaths=redeemedAt&updateMask.fieldPaths=isActive&key=${FIREBASE_API_KEY}`,
                      {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(redeemData)
                      }
                    );
                    console.log(`[Stripe Webhook] ✓ Firebase referral code ${referralCardId} marked as redeemed by ${userId}`);
                  } catch (referralError) {
                    console.error('[Stripe Webhook] Failed to mark Firebase referral code as redeemed:', referralError);
                  }
                }

                logStripeEvent(event.type, event.id, true, {
                  message: `Plus subscription activated via promo for ${userId}`,
                  metadata: { userId, plusId, promoCode },
                  processingTimeMs: Date.now() - startTime
                }).catch(() => {});
              } else {
                console.error('[Stripe Webhook] Failed to update user subscription (promo)');
              }
            } catch (updateError) {
              console.error('[Stripe Webhook] Error updating subscription (promo):', updateError);
            }
          }

          return new Response(JSON.stringify({ received: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      // Extract order data from metadata
      const metadata = session.metadata || {};
      console.log('[Stripe Webhook] Metadata keys:', Object.keys(metadata).join(', '));
      console.log('[Stripe Webhook] Metadata:', JSON.stringify(metadata, null, 2));

      // Handle gift card purchases
      if (metadata.type === 'giftcard') {
        console.log('[Stripe Webhook] 🎁 Processing gift card purchase...');

        const paymentIntentId = session.payment_intent;

        // Idempotency check for gift cards
        if (paymentIntentId) {
          try {
            const existingCards = await queryCollection('giftCards', {
              filters: [{ field: 'paymentIntentId', op: 'EQUAL', value: paymentIntentId }],
              limit: 1
            });

            if (existingCards.length > 0) {
              console.log('[Stripe Webhook] ⚠️ Gift card already exists for this payment:', existingCards[0].code);
              return new Response(JSON.stringify({
                received: true,
                message: 'Gift card already created',
                code: existingCards[0].code
              }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
          } catch (checkErr) {
            console.error('[Stripe Webhook] Gift card idempotency check failed:', checkErr);
          }
        }

        // Create the gift card
        const result = await createGiftCardAfterPayment({
          amount: parseInt(metadata.amount),
          buyerUserId: metadata.buyerUserId,
          buyerEmail: metadata.buyerEmail,
          buyerName: metadata.buyerName || '',
          recipientType: metadata.recipientType as 'gift' | 'self',
          recipientName: metadata.recipientName || '',
          recipientEmail: metadata.recipientEmail,
          message: metadata.message || '',
          paymentIntentId: paymentIntentId as string
        }, {
          queryCollection,
          addDocument,
          updateDocument,
          getDocument
        });

        if (result.success) {
          console.log('[Stripe Webhook] ✓ Gift card created:', result.giftCard?.code);
          console.log('[Stripe Webhook] ✓ Email sent:', result.emailSent);
        } else {
          console.error('[Stripe Webhook] ❌ Failed to create gift card:', result.error);
        }

        return new Response(JSON.stringify({
          received: true,
          giftCard: result.success,
          code: result.giftCard?.code
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // Skip if no customer email (not a valid order)
      if (!metadata.customer_email) {
        console.log('[Stripe Webhook] ⚠️ No customer email in metadata - skipping');
        console.log('[Stripe Webhook] Available metadata:', JSON.stringify(metadata));
        return new Response(JSON.stringify({ received: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      console.log('[Stripe Webhook] ✓ Customer email found:', metadata.customer_email);

      // IDEMPOTENCY CHECK: Check if order already exists for this payment intent
      const paymentIntentId = session.payment_intent;
      if (paymentIntentId) {
        console.log('[Stripe Webhook] Checking for existing order with paymentIntentId:', paymentIntentId);
        try {
          const existingOrders = await queryCollection('orders', {
            filters: [{ field: 'paymentIntentId', op: 'EQUAL', value: paymentIntentId }],
            limit: 1
          });

          if (existingOrders && existingOrders.length > 0) {
            console.log('[Stripe Webhook] ⚠️ Order already exists for this payment intent:', existingOrders[0].id);
            console.log('[Stripe Webhook] Order number:', existingOrders[0].orderNumber);
            console.log('[Stripe Webhook] Skipping duplicate order creation');
            return new Response(JSON.stringify({
              received: true,
              message: 'Order already exists',
              orderId: existingOrders[0].id
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          console.log('[Stripe Webhook] ✓ No existing order found - proceeding with creation');
        } catch (idempotencyErr) {
          console.error('[Stripe Webhook] ⚠️ Idempotency check failed:', idempotencyErr);
          // Continue anyway - better to risk duplicate than fail order
        }
      }

      console.log('[Stripe Webhook] 📦 Creating order...');

      // Parse items from metadata or retrieve from pending checkout
      let items: any[] = [];

      // Track artist shipping breakdown for payouts (artist gets item price + their shipping fee)
      let artistShippingBreakdown: Record<string, { artistId: string; artistName: string; amount: number }> | null = null;

      // First try items_json in metadata
      if (metadata.items_json) {
        try {
          items = JSON.parse(metadata.items_json);
          console.log('[Stripe Webhook] ✓ Parsed', items.length, 'items from metadata');
        } catch (e) {
          console.error('[Stripe Webhook] ❌ Error parsing items_json:', e);
          console.error('[Stripe Webhook] items_json value:', metadata.items_json?.substring(0, 200));
        }
      }

      // If no items in metadata, try pending checkout
      if (items.length === 0 && metadata.pending_checkout_id) {
        console.log('[Stripe Webhook] Retrieving items from pending checkout:', metadata.pending_checkout_id);
        try {
          const pendingCheckout = await getDocument('pendingCheckouts', metadata.pending_checkout_id);
          if (pendingCheckout && pendingCheckout.items) {
            items = pendingCheckout.items;
            console.log('[Stripe Webhook] ✓ Retrieved', items.length, 'items from pending checkout');

            // Get artist shipping breakdown for payouts (artist receives their shipping fee)
            if (pendingCheckout.artistShippingBreakdown) {
              artistShippingBreakdown = pendingCheckout.artistShippingBreakdown;
              console.log('[Stripe Webhook] ✓ Retrieved artist shipping breakdown:', Object.keys(artistShippingBreakdown).length, 'artists');
            }

            // Clean up pending checkout
            try {
              await deleteDocument('pendingCheckouts', metadata.pending_checkout_id);
              console.log('[Stripe Webhook] ✓ Cleaned up pending checkout');
            } catch (cleanupErr) {
              console.log('[Stripe Webhook] ⚠️ Could not clean up pending checkout:', cleanupErr);
            }
          } else {
            console.log('[Stripe Webhook] ⚠️ Pending checkout not found or has no items');
          }
        } catch (pendingErr) {
          console.error('[Stripe Webhook] ❌ Error retrieving pending checkout:', pendingErr);
        }
      }

      // If still no items, log warning
      if (items.length === 0) {
        console.log('[Stripe Webhook] ⚠️ No items found in metadata or pending checkout');
      }

      // If no items in metadata, try to retrieve from session line items
      if (items.length === 0 && stripeSecretKey) {
        console.log('[Stripe Webhook] Fetching line items from Stripe API...');
        try {
          const lineItemsResponse = await fetch(
            `https://api.stripe.com/v1/checkout/sessions/${session.id}/line_items`,
            {
              headers: {
                'Authorization': `Bearer ${stripeSecretKey}`
              }
            }
          );

          console.log('[Stripe Webhook] Line items response status:', lineItemsResponse.status);

          if (lineItemsResponse.ok) {
            const lineItemsData = await lineItemsResponse.json();
            console.log('[Stripe Webhook] Line items count:', lineItemsData.data?.length || 0);
            items = lineItemsData.data
              .filter((item: any) => item.description !== 'Processing and platform fees')
              .map((item: any, index: number) => ({
                id: `stripe_item_${index}`,
                name: item.description || 'Item',
                // Use unit_amount if available, otherwise calculate from amount_total / quantity
                price: item.price?.unit_amount
                  ? item.price.unit_amount / 100
                  : (item.amount_total / 100) / (item.quantity || 1),
                quantity: item.quantity,
                type: 'digital' // Default type
              }));
            console.log('[Stripe Webhook] ✓ Mapped', items.length, 'items from Stripe');
          } else {
            const errorText = await lineItemsResponse.text();
            console.error('[Stripe Webhook] ❌ Line items fetch failed:', errorText);
          }
        } catch (e) {
          console.error('[Stripe Webhook] ❌ Error fetching line items:', e);
        }
      }

      console.log('[Stripe Webhook] Final items count:', items.length);
      if (items.length > 0) {
        console.log('[Stripe Webhook] First item:', JSON.stringify(items[0]));
      }

      // Build shipping info from Stripe shipping details
      let shipping = null;
      if (session.shipping_details) {
        const addr = session.shipping_details.address;
        shipping = {
          address1: addr.line1 || '',
          address2: addr.line2 || '',
          city: addr.city || '',
          county: addr.state || '',
          postcode: addr.postal_code || '',
          country: getCountryName(addr.country)
        };
        console.log('[Stripe Webhook] ✓ Shipping address:', shipping.city, shipping.postcode);
      } else {
        console.log('[Stripe Webhook] No shipping details (digital order)');
      }

      console.log('[Stripe Webhook] Calling createOrder with:');
      console.log('[Stripe Webhook]   - Customer:', metadata.customer_email);
      console.log('[Stripe Webhook]   - Items:', items.length);
      console.log('[Stripe Webhook]   - Total:', session.amount_total / 100);
      console.log('[Stripe Webhook]   - PaymentIntent:', session.payment_intent);

      // Create order using shared utility
      const result = await createOrder({
        orderData: {
          customer: {
            email: metadata.customer_email,
            firstName: metadata.customer_firstName || 'Customer',
            lastName: metadata.customer_lastName || '',
            phone: metadata.customer_phone || '',
            userId: metadata.customer_userId || undefined
          },
          shipping,
          items,
          totals: {
            subtotal: parseFloat(metadata.subtotal) || (session.amount_total / 100),
            shipping: parseFloat(metadata.shipping) || 0,
            serviceFees: parseFloat(metadata.serviceFees) || 0,
            total: session.amount_total / 100,
            appliedCredit: parseFloat(metadata.appliedCredit) || 0,
            amountPaid: session.amount_total / 100
          },
          hasPhysicalItems: metadata.hasPhysicalItems === 'true',
          paymentMethod: 'stripe',
          paymentIntentId: session.payment_intent
        },
        env
      });

      console.log('[Stripe Webhook] createOrder returned:', JSON.stringify(result));

      if (!result.success) {
        console.error('[Stripe Webhook] ❌ ORDER CREATION FAILED');
        console.error('[Stripe Webhook] Error:', result.error);

        logStripeEvent(event.type, event.id, false, {
          message: 'Order creation failed',
          error: result.error || 'Unknown error',
          processingTimeMs: Date.now() - startTime
        }).catch(() => {});

        return new Response(JSON.stringify({
          error: result.error || 'Failed to create order'
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      console.log('[Stripe Webhook] ✅ ORDER CREATED SUCCESSFULLY');
      console.log('[Stripe Webhook] Order Number:', result.orderNumber);
      console.log('[Stripe Webhook] Order ID:', result.orderId);

      // Record to sales ledger (source of truth for analytics)
      // Look up seller info for ALL items so multi-seller orders are handled correctly
      try {
        const shippingAmount = parseFloat(metadata.shipping) || 0;
        const serviceFees = parseFloat(metadata.serviceFees) || 0;
        const freshWaxFee = parseFloat(metadata.freshWaxFee) || 0;
        // Estimate Stripe fee: 1.5% + £0.20 for UK cards (average)
        const stripeFee = serviceFees > 0 ? (serviceFees - freshWaxFee) : ((session.amount_total / 100) * 0.015 + 0.20);

        // Enrich items with seller info from release/product lookup
        const enrichedItems = await Promise.all(items.map(async (item: any) => {
          const releaseId = item.releaseId || item.productId || item.id;
          let submitterId = null;
          let submitterEmail = null;
          let artistName = item.artist || item.artistName || null;

          // Look up release to get submitter info
          if (releaseId && (item.type === 'digital' || item.type === 'release' || item.type === 'track' || item.releaseId)) {
            try {
              const release = await getDocument('releases', releaseId);
              if (release) {
                submitterId = release.submitterId || release.uploadedBy || release.userId || null;
                submitterEmail = release.submitterEmail || release.metadata?.email || null;
                artistName = release.artistName || release.artist || artistName;
                console.log(`[Stripe Webhook] Item ${item.name}: seller=${submitterId}`);
              }
            } catch (lookupErr) {
              console.error(`[Stripe Webhook] Failed to lookup release ${releaseId}:`, lookupErr);
            }
          }

          // For merch items, look up the merch document for seller info
          if (item.type === 'merch' && item.productId) {
            try {
              const merch = await getDocument('merch', item.productId);
              if (merch) {
                submitterId = merch.sellerId || merch.userId || merch.createdBy || null;
                submitterEmail = merch.sellerEmail || null;
                artistName = merch.sellerName || merch.brandName || artistName;
                console.log(`[Stripe Webhook] Merch ${item.name}: seller=${submitterId}`);
              }
            } catch (lookupErr) {
              console.error(`[Stripe Webhook] Failed to lookup merch ${item.productId}:`, lookupErr);
            }
          }

          return {
            ...item,
            submitterId,
            submitterEmail,
            artistName
          };
        }));

        // Use multi-seller recording to create per-seller ledger entries
        await recordMultiSellerSale({
          orderId: result.orderId,
          orderNumber: result.orderNumber || '',
          customerId: metadata.customer_userId || null,
          customerEmail: metadata.customer_email,
          grossTotal: session.amount_total / 100,
          shipping: shippingAmount,
          stripeFee: Math.round(stripeFee * 100) / 100,
          freshWaxFee,
          paymentMethod: 'stripe',
          paymentId: session.payment_intent as string,
          hasPhysical: metadata.hasPhysicalItems === 'true',
          hasDigital: enrichedItems.some((i: any) => i.type === 'digital' || i.type === 'release' || i.type === 'track'),
          items: enrichedItems
        });
        console.log('[Stripe Webhook] ✅ Sale recorded to ledger (per-seller entries created)');
      } catch (ledgerErr) {
        console.error('[Stripe Webhook] ⚠️ Failed to record to ledger:', ledgerErr);
        // Don't fail the order, ledger is supplementary
      }

      // Process artist payments via Stripe Connect
      if (result.orderId && stripeSecretKey) {
        // Calculate total item count for fair fee splitting across all item types
        const totalItemCount = items.length;

        // Calculate order subtotal for processing fee calculation
        const orderSubtotal = items.reduce((sum: number, item: any) => {
          return sum + ((item.price || 0) * (item.quantity || 1));
        }, 0);

        console.log('[Stripe Webhook] 💰 Processing artist payments...');
        await processArtistPayments({
          orderId: result.orderId,
          orderNumber: result.orderNumber || '',
          items,
          totalItemCount,
          orderSubtotal,
          artistShippingBreakdown, // Include shipping fees for artists who ship vinyl
          stripeSecretKey,
          env
        });

        // Process supplier payments for merch items
        console.log('[Stripe Webhook] 🏭 Processing supplier payments...');
        await processSupplierPayments({
          orderId: result.orderId,
          orderNumber: result.orderNumber || '',
          items,
          totalItemCount,
          orderSubtotal,
          stripeSecretKey,
          env
        });

        // Process vinyl crate seller payments
        console.log('[Stripe Webhook] 📦 Processing vinyl crate seller payments...');
        await processVinylCrateSellerPayments({
          orderId: result.orderId,
          orderNumber: result.orderNumber || '',
          items,
          totalItemCount,
          orderSubtotal,
          stripeSecretKey,
          env
        });
      }

      // Deduct applied credit from user's balance
      const appliedCredit = parseFloat(metadata.appliedCredit) || 0;
      const userId = metadata.customer_userId;
      if (appliedCredit > 0 && userId) {
        console.log('[Stripe Webhook] 💳 Deducting applied credit:', appliedCredit, 'from user:', userId);
        try {
          const creditData = await getDocument('userCredits', userId);
          if (creditData && creditData.balance >= appliedCredit) {
            const newBalance = creditData.balance - appliedCredit;
            const now = new Date().toISOString();

            // Create transaction record
            const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const transaction = {
              id: transactionId,
              type: 'purchase',
              amount: -appliedCredit,
              description: `Applied to order ${result.orderNumber || result.orderId}`,
              orderId: result.orderId,
              orderNumber: result.orderNumber,
              createdAt: now,
              balanceAfter: newBalance
            };

            const existingTransactions = creditData.transactions || [];
            existingTransactions.push(transaction);

            await updateDocument('userCredits', userId, {
              balance: newBalance,
              lastUpdated: now,
              transactions: existingTransactions
            });

            // Also update user document
            await updateDocument('users', userId, {
              creditBalance: newBalance,
              creditUpdatedAt: now
            });

            console.log('[Stripe Webhook] ✅ Credit deducted, new balance:', newBalance);
          } else {
            console.warn('[Stripe Webhook] ⚠️ Insufficient credit balance for deduction');
          }
        } catch (creditErr) {
          console.error('[Stripe Webhook] ❌ Failed to deduct credit:', creditErr);
          // Don't fail the order, just log the error
        }
      }

      console.log('[Stripe Webhook] ========== WEBHOOK COMPLETE ==========');

      // Log successful order
      logStripeEvent(event.type, event.id, true, {
        message: `Order ${result.orderNumber} created successfully`,
        metadata: { orderId: result.orderId, orderNumber: result.orderNumber, amount: session.amount_total / 100 },
        processingTimeMs: Date.now() - startTime
      }).catch(() => {}); // Don't let logging failures affect response
    }

    // Handle payment_intent.succeeded (backup for session complete)
    if (event.type === 'payment_intent.succeeded') {
      console.log('[Stripe Webhook] Payment intent succeeded:', event.data.object.id);
      // Order should already be created by checkout.session.completed
    }

    // Handle subscription renewal (invoice.payment_succeeded for recurring payments)
    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object;
      console.log('[Stripe Webhook] ========== INVOICE PAYMENT SUCCEEDED ==========');
      console.log('[Stripe Webhook] Invoice ID:', invoice.id);
      console.log('[Stripe Webhook] Billing reason:', invoice.billing_reason);
      console.log('[Stripe Webhook] Subscription:', invoice.subscription);

      // Only process subscription renewals, not initial payments
      if (invoice.billing_reason === 'subscription_cycle' && invoice.subscription) {
        console.log('[Stripe Webhook] 👑 Processing Plus subscription RENEWAL...');

        // Get subscription details from Stripe
        const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
        if (stripeSecretKey) {
          try {
            const subResponse = await fetch(
              `https://api.stripe.com/v1/subscriptions/${invoice.subscription}`,
              {
                headers: { 'Authorization': `Bearer ${stripeSecretKey}` }
              }
            );
            const subscription = await subResponse.json();

            if (subscription.metadata?.userId) {
              const userId = subscription.metadata.userId;
              const email = invoice.customer_email || subscription.metadata.email;

              // Calculate new expiry (extend by 1 year from current expiry or now)
              const FIREBASE_PROJECT_ID = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
              const FIREBASE_API_KEY = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

              // Get current user to check existing expiry
              const userResponse = await fetch(
                `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}?key=${FIREBASE_API_KEY}`
              );
              const userData = await userResponse.json();

              let baseDate = new Date();
              if (userData.fields?.subscription?.mapValue?.fields?.expiresAt?.stringValue) {
                const currentExpiry = new Date(userData.fields.subscription.mapValue.fields.expiresAt.stringValue);
                if (currentExpiry > baseDate) {
                  baseDate = currentExpiry; // Extend from current expiry if not yet expired
                }
              }

              const newExpiry = new Date(baseDate);
              newExpiry.setFullYear(newExpiry.getFullYear() + 1); // Add 1 year

              // Update subscription expiry
              const updateData = {
                fields: {
                  'subscription': {
                    mapValue: {
                      fields: {
                        tier: { stringValue: 'pro' },
                        expiresAt: { stringValue: newExpiry.toISOString() },
                        lastRenewal: { stringValue: new Date().toISOString() },
                        subscriptionId: { stringValue: invoice.subscription },
                        paymentMethod: { stringValue: 'stripe' }
                      }
                    }
                  }
                }
              };

              // Preserve existing fields
              if (userData.fields?.subscription?.mapValue?.fields?.subscribedAt?.stringValue) {
                updateData.fields.subscription.mapValue.fields.subscribedAt =
                  userData.fields.subscription.mapValue.fields.subscribedAt;
              }
              if (userData.fields?.subscription?.mapValue?.fields?.plusId?.stringValue) {
                updateData.fields.subscription.mapValue.fields.plusId =
                  userData.fields.subscription.mapValue.fields.plusId;
              }

              const updateResponse = await fetch(
                `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}?updateMask.fieldPaths=subscription&key=${FIREBASE_API_KEY}`,
                {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(updateData)
                }
              );

              if (updateResponse.ok) {
                console.log('[Stripe Webhook] ✓ Subscription renewed for:', userId);
                console.log('[Stripe Webhook] New expiry:', newExpiry.toISOString());

                // Send renewal confirmation email
                try {
                  const origin = new URL(request.url).origin;
                  await fetch(`${origin}/api/admin/send-plus-welcome-email`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      email: email,
                      name: subscription.metadata.userName || email?.split('@')[0],
                      subscribedAt: userData.fields?.subscription?.mapValue?.fields?.subscribedAt?.stringValue,
                      expiresAt: newExpiry.toISOString(),
                      plusId: userData.fields?.subscription?.mapValue?.fields?.plusId?.stringValue,
                      isRenewal: true
                    })
                  });
                  console.log('[Stripe Webhook] ✓ Renewal email sent to:', email);
                } catch (emailError) {
                  console.error('[Stripe Webhook] Failed to send renewal email:', emailError);
                }
              } else {
                console.error('[Stripe Webhook] Failed to update subscription on renewal');
              }
            } else {
              console.log('[Stripe Webhook] No userId in subscription metadata');
            }
          } catch (subError) {
            console.error('[Stripe Webhook] Error processing renewal:', subError);
          }
        }
      }
    }

    // Handle subscription cancelled/expired
    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      console.log('[Stripe Webhook] ========== SUBSCRIPTION CANCELLED ==========');
      console.log('[Stripe Webhook] Subscription ID:', subscription.id);

      // User's subscription has been cancelled - they'll naturally lose Plus when expiresAt passes
      // The getEffectiveTier() function handles this automatically
      // Optionally, we could immediately downgrade or send a cancellation email here
    }

    // Handle dispute created - reverse transfers to recover funds from artists
    if (event.type === 'charge.dispute.created') {
      const dispute = event.data.object;
      console.log('[Stripe Webhook] ========== DISPUTE CREATED ==========');
      console.log('[Stripe Webhook] Dispute ID:', dispute.id);
      console.log('[Stripe Webhook] Charge ID:', dispute.charge);
      console.log('[Stripe Webhook] Amount:', dispute.amount / 100, dispute.currency?.toUpperCase());
      console.log('[Stripe Webhook] Reason:', dispute.reason);

      await handleDisputeCreated(dispute, stripeSecretKey);

      logStripeEvent(event.type, event.id, true, {
        message: `Dispute created: ${dispute.reason}`,
        metadata: { disputeId: dispute.id, chargeId: dispute.charge, amount: dispute.amount / 100 },
        processingTimeMs: Date.now() - startTime
      }).catch(() => {});
    }

    // Handle dispute closed - track outcome
    if (event.type === 'charge.dispute.closed') {
      const dispute = event.data.object;
      console.log('[Stripe Webhook] ========== DISPUTE CLOSED ==========');
      console.log('[Stripe Webhook] Dispute ID:', dispute.id);
      console.log('[Stripe Webhook] Status:', dispute.status);

      await handleDisputeClosed(dispute, stripeSecretKey);

      logStripeEvent(event.type, event.id, true, {
        message: `Dispute closed: ${dispute.status}`,
        metadata: { disputeId: dispute.id, status: dispute.status },
        processingTimeMs: Date.now() - startTime
      }).catch(() => {});
    }

    // Handle refund - reverse artist transfers proportionally
    if (event.type === 'charge.refunded') {
      const charge = event.data.object as any;
      console.log('[Stripe Webhook] ========== REFUND PROCESSED ==========');
      console.log('[Stripe Webhook] Charge ID:', charge.id);
      console.log('[Stripe Webhook] Amount refunded:', charge.amount_refunded / 100, charge.currency?.toUpperCase());
      console.log('[Stripe Webhook] Total amount:', charge.amount / 100, charge.currency?.toUpperCase());

      await handleRefund(charge, stripeSecretKey, env);

      logStripeEvent(event.type, event.id, true, {
        message: `Refund processed: £${(charge.amount_refunded / 100).toFixed(2)}`,
        metadata: { chargeId: charge.id, amountRefunded: charge.amount_refunded / 100 },
        processingTimeMs: Date.now() - startTime
      }).catch(() => {});
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Stripe Webhook] Error:', errorMessage);

    // Log error
    logStripeEvent('webhook_error', 'unknown', false, {
      message: 'Webhook processing error',
      error: errorMessage
    }).catch(() => {});
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

function getCountryName(code: string): string {
  const countryMap: { [key: string]: string } = {
    'GB': 'United Kingdom',
    'IE': 'Ireland',
    'DE': 'Germany',
    'FR': 'France',
    'NL': 'Netherlands',
    'BE': 'Belgium',
    'US': 'United States',
    'CA': 'Canada',
    'AU': 'Australia'
  };
  return countryMap[code] || code;
}

// Process artist payments - creates pending payouts for manual review
// NOTE: Automatic payouts disabled - all payouts are manual for now
async function processArtistPayments(params: {
  orderId: string;
  orderNumber: string;
  items: any[];
  totalItemCount: number;
  orderSubtotal: number;
  artistShippingBreakdown?: Record<string, { artistId: string; artistName: string; amount: number }> | null;
  stripeSecretKey: string;
  env: any;
}) {
  const { orderId, orderNumber, items, totalItemCount, orderSubtotal, artistShippingBreakdown, env } = params;

  try {
    // Group items by artist (using releaseId to look up artist)
    const artistPayments: Record<string, {
      artistId: string;
      artistName: string;
      artistEmail: string;
      amount: number;
      shippingAmount?: number;
      items: string[];
    }> = {};

    // Cache for release lookups
    const releaseCache: Record<string, any> = {};

    for (const item of items) {
      // Skip merch items - they go to suppliers, not artists
      if (item.type === 'merch') continue;

      const releaseId = item.releaseId || item.id;
      if (!releaseId) continue;

      let release = releaseCache[releaseId];
      if (!release) {
        release = await getDocument('releases', releaseId);
        if (release) releaseCache[releaseId] = release;
      }

      if (!release) continue;

      const artistId = item.artistId || release.artistId || release.userId;
      if (!artistId) continue;

      let artist = null;
      try {
        artist = await getDocument('artists', artistId);
      } catch (e) {
        console.log('[Stripe Webhook] Could not find artist:', artistId);
      }

      const itemTotal = (item.price || 0) * (item.quantity || 1);

      // 1% Fresh Wax platform fee
      const freshWaxFee = itemTotal * 0.01;
      // Processing fee: total order fee (1.4% + £0.20) split equally among all sellers
      const totalProcessingFee = (orderSubtotal * 0.014) + 0.20;
      const processingFeePerSeller = totalProcessingFee / totalItemCount;
      const artistShare = itemTotal - freshWaxFee - processingFeePerSeller;

      if (!artistPayments[artistId]) {
        artistPayments[artistId] = {
          artistId,
          artistName: artist?.artistName || release.artistName || release.artist || 'Unknown Artist',
          artistEmail: artist?.email || release.artistEmail || '',
          amount: 0,
          items: []
        };
      }

      artistPayments[artistId].amount += artistShare;
      artistPayments[artistId].items.push(item.name || item.title || 'Item');
    }

    // Add shipping fees to artist payments (artists receive 100% of their vinyl shipping)
    if (artistShippingBreakdown) {
      for (const artistId of Object.keys(artistShippingBreakdown)) {
        const shippingInfo = artistShippingBreakdown[artistId];
        if (artistPayments[artistId] && shippingInfo.amount > 0) {
          artistPayments[artistId].amount += shippingInfo.amount;
          artistPayments[artistId].shippingAmount = shippingInfo.amount;
          console.log('[Stripe Webhook] Added shipping fee for', shippingInfo.artistName, ':', shippingInfo.amount, 'GBP');
        }
      }
    }

    console.log('[Stripe Webhook] Artist pending payouts to create:', Object.keys(artistPayments).length);

    for (const artistId of Object.keys(artistPayments)) {
      const payment = artistPayments[artistId];
      if (payment.amount <= 0) continue;

      console.log('[Stripe Webhook] Creating pending payout for', payment.artistName, ':', payment.amount.toFixed(2), 'GBP');

      const itemAmount = payment.amount - (payment.shippingAmount || 0);

      // Always create pending payout for manual processing
      await addDocument('pendingPayouts', {
        artistId: payment.artistId,
        artistName: payment.artistName,
        artistEmail: payment.artistEmail,
        orderId,
        orderNumber,
        amount: payment.amount,
        itemAmount: itemAmount,
        shippingAmount: payment.shippingAmount || 0,
        currency: 'gbp',
        status: 'pending',
        customerPaymentMethod: 'stripe',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      // Update artist's pending balance
      try {
        const artist = await getDocument('artists', payment.artistId);
        if (artist) {
          await updateDocument('artists', payment.artistId, {
            pendingBalance: (artist.pendingBalance || 0) + payment.amount,
            updatedAt: new Date().toISOString()
          });
        }
      } catch (e) {
        console.log('[Stripe Webhook] Could not update artist pending balance');
      }

      console.log('[Stripe Webhook] ✓ Pending payout created for', payment.artistName);
    }

  } catch (error: any) {
    console.error('[Stripe Webhook] Error processing artist payments:', error.message);
    // Don't throw - order was created, payments can be retried
  }
}

// Process supplier payments for merch items via Stripe Connect
async function processSupplierPayments(params: {
  orderId: string;
  orderNumber: string;
  items: any[];
  totalItemCount: number;
  orderSubtotal: number;
  stripeSecretKey: string;
  env: any;
}) {
  const { orderId, orderNumber, items, totalItemCount, orderSubtotal, stripeSecretKey, env } = params;
  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  try {
    // Filter to only merch items
    const merchItems = items.filter(item => item.type === 'merch');

    if (merchItems.length === 0) {
      console.log('[Stripe Webhook] No merch items in order - skipping supplier payments');
      return;
    }

    console.log('[Stripe Webhook] Processing', merchItems.length, 'merch items for supplier payments');

    // Group items by supplier
    const supplierPayments: Record<string, {
      supplierId: string;
      supplierName: string;
      supplierEmail: string;
      stripeConnectId: string | null;
      amount: number;
      items: string[];
    }> = {};

    // Cache for merch product lookups
    const merchCache: Record<string, any> = {};

    for (const item of merchItems) {
      // Get merch product data to find supplier
      const productId = item.productId || item.merchId || item.id;
      if (!productId) continue;

      let product = merchCache[productId];
      if (!product) {
        product = await getDocument('merch', productId);
        if (product) {
          merchCache[productId] = product;
        }
      }

      if (!product) {
        console.log('[Stripe Webhook] Merch product not found:', productId);
        continue;
      }

      // Get supplier ID from product
      const supplierId = product.supplierId;
      if (!supplierId) {
        console.log('[Stripe Webhook] No supplier ID on merch product:', productId);
        continue;
      }

      // Look up supplier for Connect details
      let supplier = null;
      try {
        supplier = await getDocument('merch-suppliers', supplierId);
      } catch (e) {
        console.log('[Stripe Webhook] Could not find supplier:', supplierId);
      }

      if (!supplier) continue;

      // Calculate supplier share (same structure as releases/vinyl, but 5% Fresh Wax fee)
      const itemPrice = item.price || 0;
      const itemTotal = itemPrice * (item.quantity || 1);
      const freshWaxFee = itemTotal * 0.05; // 5% for merch
      // Processing fee: total order fee (1.4% + £0.20) split equally among all sellers
      const totalProcessingFee = (orderSubtotal * 0.014) + 0.20;
      const processingFeePerSeller = totalProcessingFee / totalItemCount;
      const supplierShare = itemTotal - freshWaxFee - processingFeePerSeller;

      // Group by supplier
      if (!supplierPayments[supplierId]) {
        supplierPayments[supplierId] = {
          supplierId,
          supplierName: supplier.name || 'Unknown Supplier',
          supplierEmail: supplier.email || '',
          stripeConnectId: supplier.stripeConnectId || null,
          paypalEmail: supplier.paypalEmail || null,
          payoutMethod: supplier.payoutMethod || null,
          amount: 0,
          items: []
        };
      }

      supplierPayments[supplierId].amount += supplierShare;
      supplierPayments[supplierId].items.push(item.name || item.title || 'Item');
    }

    console.log('[Stripe Webhook] Supplier payments to process:', Object.keys(supplierPayments).length);

    // Process each supplier payment
    const supplierPaypalConfig = getPayPalConfig(env);

    for (const supplierId of Object.keys(supplierPayments)) {
      const payment = supplierPayments[supplierId];

      if (payment.amount <= 0) continue;

      console.log('[Stripe Webhook] Processing payment for supplier', payment.supplierName, ':', payment.amount.toFixed(2), 'GBP');

      // NOTE: Automatic payouts disabled - all supplier payouts are manual for now
      // Always create pending payout for manual processing
      console.log('[Stripe Webhook] Creating pending payout for supplier', payment.supplierName);

      await addDocument('pendingSupplierPayouts', {
        supplierId: payment.supplierId,
        supplierName: payment.supplierName,
        supplierEmail: payment.supplierEmail,
        paypalEmail: payment.paypalEmail,
        stripeConnectId: payment.stripeConnectId,
        payoutMethod: payment.payoutMethod,
        orderId,
        orderNumber,
        amount: payment.amount,
        currency: 'gbp',
        status: 'pending',
        items: payment.items,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      // Update supplier's pending balance
      const supplier = await getDocument('merch-suppliers', payment.supplierId);
      if (supplier) {
        await updateDocument('merch-suppliers', payment.supplierId, {
          pendingBalance: (supplier.pendingBalance || 0) + payment.amount
        });
      }

      console.log('[Stripe Webhook] ✓ Pending supplier payout created for', payment.supplierName);
    }

  } catch (error: any) {
    console.error('[Stripe Webhook] Error processing supplier payments:', error.message);
    // Don't throw - order was created, payments can be retried
  }
}

// Process vinyl crate seller payments via Stripe Connect
async function processVinylCrateSellerPayments(params: {
  orderId: string;
  orderNumber: string;
  items: any[];
  totalItemCount: number;
  orderSubtotal: number;
  stripeSecretKey: string;
  env: any;
}) {
  const { orderId, orderNumber, items, totalItemCount, orderSubtotal, stripeSecretKey, env } = params;
  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  try {
    // Filter to only vinyl crate items (type: 'crate' or 'vinyl-crate' or has crateListingId)
    const crateItems = items.filter(item =>
      item.type === 'crate' ||
      item.type === 'vinyl-crate' ||
      item.crateListingId ||
      item.sellerId // Items with a seller are from crates
    );

    if (crateItems.length === 0) {
      console.log('[Stripe Webhook] No vinyl crate items in order - skipping seller payments');
      return;
    }

    console.log('[Stripe Webhook] Processing', crateItems.length, 'vinyl crate items for seller payments');

    // Group items by seller
    const sellerPayments: Record<string, {
      sellerId: string;
      sellerName: string;
      sellerEmail: string;
      stripeConnectId: string | null;
      amount: number;
      items: string[];
    }> = {};

    // Cache for crate listing lookups
    const listingCache: Record<string, any> = {};

    for (const item of crateItems) {
      // Get the seller info
      let sellerId = item.sellerId;
      let listingId = item.crateListingId || item.listingId;

      // If no sellerId, try to get from listing
      if (!sellerId && listingId) {
        let listing = listingCache[listingId];
        if (!listing) {
          listing = await getDocument('crateListings', listingId);
          if (listing) {
            listingCache[listingId] = listing;
          }
        }
        if (listing) {
          sellerId = listing.sellerId || listing.userId;
        }
      }

      if (!sellerId) {
        console.log('[Stripe Webhook] No seller ID for crate item:', item.name);
        continue;
      }

      // Look up seller (user) for Connect details
      let seller = null;
      try {
        seller = await getDocument('users', sellerId);
      } catch (e) {
        console.log('[Stripe Webhook] Could not find seller user:', sellerId);
      }

      if (!seller) continue;

      // Calculate seller share (same structure as releases)
      // 1% Fresh Wax fee + payment processor fees
      const itemPrice = item.price || 0;
      const itemTotal = itemPrice * (item.quantity || 1);
      const freshWaxFee = itemTotal * 0.01;
      // Processing fee: total order fee (1.4% + £0.20) split equally among all sellers
      const totalProcessingFee = (orderSubtotal * 0.014) + 0.20;
      const processingFeePerSeller = totalProcessingFee / totalItemCount;
      const sellerShare = itemTotal - freshWaxFee - processingFeePerSeller;

      // Group by seller
      if (!sellerPayments[sellerId]) {
        sellerPayments[sellerId] = {
          sellerId,
          sellerName: seller.displayName || seller.name || 'Seller',
          sellerEmail: seller.email || '',
          stripeConnectId: seller.stripeConnectId || null,
          paypalEmail: seller.paypalEmail || null,
          payoutMethod: seller.payoutMethod || null,
          amount: 0,
          items: []
        };
      }

      sellerPayments[sellerId].amount += sellerShare;
      sellerPayments[sellerId].items.push(item.name || item.title || 'Vinyl');
    }

    console.log('[Stripe Webhook] Vinyl crate seller payments to process:', Object.keys(sellerPayments).length);

    // Process each seller payment
    const sellerPaypalConfig = getPayPalConfig(env);

    for (const sellerId of Object.keys(sellerPayments)) {
      const payment = sellerPayments[sellerId];

      if (payment.amount <= 0) continue;

      console.log('[Stripe Webhook] Processing payment for seller', payment.sellerName, ':', payment.amount.toFixed(2), 'GBP');

      // NOTE: Automatic payouts disabled - all crate seller payouts are manual for now
      // Always create pending payout for manual processing
      console.log('[Stripe Webhook] Creating pending payout for crate seller', payment.sellerName);

      await addDocument('pendingCrateSellerPayouts', {
        sellerId: payment.sellerId,
        sellerName: payment.sellerName,
        sellerEmail: payment.sellerEmail,
        paypalEmail: payment.paypalEmail,
        stripeConnectId: payment.stripeConnectId,
        payoutMethod: payment.payoutMethod,
        orderId,
        orderNumber,
        amount: payment.amount,
        currency: 'gbp',
        status: 'pending',
        items: payment.items,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      // Update seller's pending crate balance
      const seller = await getDocument('users', payment.sellerId);
      if (seller) {
        await updateDocument('users', payment.sellerId, {
          pendingCrateBalance: (seller.pendingCrateBalance || 0) + payment.amount
        });
      }

      console.log('[Stripe Webhook] ✓ Pending crate seller payout created for', payment.sellerName);
    }

  } catch (error: any) {
    console.error('[Stripe Webhook] Error processing vinyl crate seller payments:', error.message);
    // Don't throw - order was created, payments can be retried
  }
}

// Handle dispute created - reverse transfers to recover funds from artists
async function handleDisputeCreated(dispute: any, stripeSecretKey: string) {
  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  try {
    const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
    const disputeAmount = dispute.amount / 100; // Convert from cents to GBP

    console.log('[Stripe Webhook] Processing dispute for charge:', chargeId);

    // Get the charge to find the payment intent and transfer group
    const charge = await stripe.charges.retrieve(chargeId, {
      expand: ['transfer_group', 'payment_intent']
    });

    const paymentIntentId = typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : charge.payment_intent?.id;

    // Find the order by payment intent
    let order = null;
    if (paymentIntentId) {
      const orders = await queryCollection('orders', {
        filters: [{ field: 'paymentIntentId', op: 'EQUAL', value: paymentIntentId }],
        limit: 1
      });
      order = orders[0];
    }

    // Find related transfers by transfer_group (orderId)
    const transferGroup = charge.transfer_group || order?.id;
    let transfersReversed: any[] = [];
    let totalRecovered = 0;

    if (transferGroup) {
      // List all transfers in this transfer group
      const transfers = await stripe.transfers.list({
        transfer_group: transferGroup,
        limit: 100
      });

      console.log('[Stripe Webhook] Found', transfers.data.length, 'transfers to potentially reverse');

      // Reverse each transfer to recover funds
      for (const transfer of transfers.data) {
        // Skip if already fully reversed
        if (transfer.reversed) {
          console.log('[Stripe Webhook] Transfer already reversed:', transfer.id);
          continue;
        }

        try {
          // Reverse the transfer
          const reversal = await stripe.transfers.createReversal(transfer.id, {
            description: `Dispute ${dispute.id} - ${dispute.reason}`,
            metadata: {
              disputeId: dispute.id,
              reason: dispute.reason,
              chargeId: chargeId
            }
          });

          const reversedAmount = reversal.amount / 100;
          totalRecovered += reversedAmount;

          transfersReversed.push({
            transferId: transfer.id,
            reversalId: reversal.id,
            amount: reversedAmount,
            artistId: transfer.metadata?.artistId,
            artistName: transfer.metadata?.artistName
          });

          console.log('[Stripe Webhook] ✓ Reversed transfer:', transfer.id, 'Amount:', reversedAmount);

          // Update the payout record
          const payouts = await queryCollection('payouts', {
            filters: [{ field: 'stripeTransferId', op: 'EQUAL', value: transfer.id }],
            limit: 1
          });

          if (payouts.length > 0) {
            await updateDocument('payouts', payouts[0].id, {
              status: 'reversed',
              reversedAt: new Date().toISOString(),
              reversedAmount: reversedAmount,
              reversalReason: `Dispute: ${dispute.reason}`,
              disputeId: dispute.id,
              updatedAt: new Date().toISOString()
            });
          }

          // Update artist's total earnings
          const artistId = transfer.metadata?.artistId;
          if (artistId) {
            const artist = await getDocument('artists', artistId);
            if (artist) {
              await updateDocument('artists', artistId, {
                totalEarnings: Math.max(0, (artist.totalEarnings || 0) - reversedAmount),
                updatedAt: new Date().toISOString()
              });
            }
          }

        } catch (reversalError: any) {
          console.error('[Stripe Webhook] Failed to reverse transfer:', transfer.id, reversalError.message);
        }
      }
    }

    // Create dispute record in Firestore
    await addDocument('disputes', {
      stripeDisputeId: dispute.id,
      stripeChargeId: chargeId,
      stripePaymentIntentId: paymentIntentId || null,
      orderId: order?.id || transferGroup || null,
      orderNumber: order?.orderNumber || null,
      amount: disputeAmount,
      currency: dispute.currency || 'gbp',
      reason: dispute.reason,
      status: 'open',
      evidenceDueBy: dispute.evidence_details?.due_by
        ? new Date(dispute.evidence_details.due_by * 1000).toISOString()
        : null,
      transfersReversed: transfersReversed,
      amountRecovered: totalRecovered,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    console.log('[Stripe Webhook] ✓ Dispute recorded. Recovered:', totalRecovered, 'GBP from', transfersReversed.length, 'transfers');

  } catch (error: any) {
    console.error('[Stripe Webhook] Error handling dispute:', error.message);
    // Still record the dispute even if transfer reversal failed
    await addDocument('disputes', {
      stripeDisputeId: dispute.id,
      stripeChargeId: typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id,
      amount: dispute.amount / 100,
      currency: dispute.currency || 'gbp',
      reason: dispute.reason,
      status: 'open',
      error: error.message,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }
}

// Handle dispute closed - update status and track outcome
async function handleDisputeClosed(dispute: any, stripeSecretKey: string) {
  try {
    // Find the dispute record
    const disputes = await queryCollection('disputes', {
      filters: [{ field: 'stripeDisputeId', op: 'EQUAL', value: dispute.id }],
      limit: 1
    });

    if (disputes.length === 0) {
      console.log('[Stripe Webhook] Dispute record not found:', dispute.id);
      return;
    }

    const disputeRecord = disputes[0];
    const outcome = dispute.status === 'won' ? 'won' : 'lost';

    // Calculate net impact
    let netImpact = 0;
    let retransfersCreated: any[] = [];

    if (outcome === 'lost') {
      // We lost - platform absorbs the loss minus any recovered amount
      netImpact = disputeRecord.amount - (disputeRecord.amountRecovered || 0);
    } else if (outcome === 'won' && disputeRecord.transfersReversed?.length > 0) {
      // We won - re-transfer to artists since they shouldn't lose money
      console.log('[Stripe Webhook] Dispute won - re-transferring to artists');

      const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

      for (const reversedTransfer of disputeRecord.transfersReversed) {
        try {
          // Get the artist's current Stripe Connect ID
          const artist = await getDocument('artists', reversedTransfer.artistId);

          if (!artist?.stripeConnectId || artist.stripeConnectStatus !== 'active') {
            console.log('[Stripe Webhook] Artist', reversedTransfer.artistId, 'no longer has active Connect - storing as pending');

            // Store as pending payout
            await addDocument('pendingPayouts', {
              artistId: reversedTransfer.artistId,
              artistName: reversedTransfer.artistName,
              artistEmail: artist?.email || '',
              orderId: disputeRecord.orderId,
              orderNumber: disputeRecord.orderNumber || '',
              amount: reversedTransfer.amount,
              currency: 'gbp',
              status: 'awaiting_connect',
              reason: 'dispute_won_retransfer',
              originalTransferId: reversedTransfer.transferId,
              disputeId: dispute.id,
              notificationSent: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            });
            continue;
          }

          // Create new transfer
          const transfer = await stripe.transfers.create({
            amount: Math.round(reversedTransfer.amount * 100),
            currency: 'gbp',
            destination: artist.stripeConnectId,
            transfer_group: disputeRecord.orderId,
            metadata: {
              orderId: disputeRecord.orderId,
              orderNumber: disputeRecord.orderNumber || '',
              artistId: reversedTransfer.artistId,
              artistName: reversedTransfer.artistName,
              reason: 'dispute_won_retransfer',
              originalTransferId: reversedTransfer.transferId,
              disputeId: dispute.id,
              platform: 'freshwax'
            }
          });

          retransfersCreated.push({
            newTransferId: transfer.id,
            originalTransferId: reversedTransfer.transferId,
            amount: reversedTransfer.amount,
            artistId: reversedTransfer.artistId,
            artistName: reversedTransfer.artistName
          });

          // Create payout record
          await addDocument('payouts', {
            artistId: reversedTransfer.artistId,
            artistName: reversedTransfer.artistName,
            artistEmail: artist.email || '',
            stripeConnectId: artist.stripeConnectId,
            stripeTransferId: transfer.id,
            orderId: disputeRecord.orderId,
            orderNumber: disputeRecord.orderNumber || '',
            amount: reversedTransfer.amount,
            currency: 'gbp',
            status: 'completed',
            reason: 'dispute_won_retransfer',
            originalTransferId: reversedTransfer.transferId,
            disputeId: dispute.id,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          });

          // Restore artist's earnings
          await updateDocument('artists', reversedTransfer.artistId, {
            totalEarnings: (artist.totalEarnings || 0) + reversedTransfer.amount,
            updatedAt: new Date().toISOString()
          });

          console.log('[Stripe Webhook] ✓ Re-transferred', reversedTransfer.amount, 'GBP to', reversedTransfer.artistName);

        } catch (retransferError: any) {
          console.error('[Stripe Webhook] Failed to re-transfer to artist:', reversedTransfer.artistId, retransferError.message);

          // Store as pending for retry
          await addDocument('pendingPayouts', {
            artistId: reversedTransfer.artistId,
            artistName: reversedTransfer.artistName,
            orderId: disputeRecord.orderId,
            orderNumber: disputeRecord.orderNumber || '',
            amount: reversedTransfer.amount,
            currency: 'gbp',
            status: 'retry_pending',
            reason: 'dispute_won_retransfer',
            originalTransferId: reversedTransfer.transferId,
            disputeId: dispute.id,
            failureReason: retransferError.message,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }
      }

      netImpact = 0; // We recovered the funds and paid artists
    }

    await updateDocument('disputes', disputeRecord.id, {
      status: outcome === 'won' ? 'won' : 'lost',
      outcome: outcome,
      resolvedAt: new Date().toISOString(),
      netImpact: netImpact,
      retransfersCreated: retransfersCreated.length > 0 ? retransfersCreated : null,
      retransferCount: retransfersCreated.length,
      updatedAt: new Date().toISOString()
    });

    console.log('[Stripe Webhook] ✓ Dispute', dispute.id, 'closed with outcome:', outcome);
    if (retransfersCreated.length > 0) {
      console.log('[Stripe Webhook]   Re-transfers created:', retransfersCreated.length);
    }
    if (netImpact > 0) {
      console.log('[Stripe Webhook]   Net platform loss:', netImpact, 'GBP');
    }

  } catch (error: any) {
    console.error('[Stripe Webhook] Error handling dispute closure:', error.message);
  }
}

// Handle refund - reverse artist transfers proportionally
async function handleRefund(charge: any, stripeSecretKey: string, env: any) {
  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });

  try {
    const paymentIntentId = typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : charge.payment_intent?.id;

    if (!paymentIntentId) {
      console.log('[Stripe Webhook] No payment intent on charge, skipping refund handling');
      return;
    }

    // Find the order by payment intent
    const orders = await queryCollection('orders', {
      filters: [{ field: 'paymentIntentId', op: 'EQUAL', value: paymentIntentId }],
      limit: 1
    });

    if (orders.length === 0) {
      console.log('[Stripe Webhook] No order found for payment intent:', paymentIntentId);
      return;
    }

    const order = orders[0];
    const orderId = order.id;

    // Calculate refund percentage
    const totalAmount = charge.amount / 100; // Total charge in GBP
    const refundedAmount = charge.amount_refunded / 100; // Amount refunded in GBP
    const refundPercentage = refundedAmount / totalAmount;
    const isFullRefund = refundPercentage >= 0.99; // Allow for rounding

    console.log('[Stripe Webhook] Order:', orderId);
    console.log('[Stripe Webhook] Refund percentage:', (refundPercentage * 100).toFixed(1) + '%');
    console.log('[Stripe Webhook] Full refund:', isFullRefund);

    // Check if we've already processed refunds for this charge
    const existingRefunds = await queryCollection('refunds', {
      filters: [{ field: 'stripeChargeId', op: 'EQUAL', value: charge.id }],
      limit: 1
    });

    // Calculate how much we've already refunded
    let previouslyRefunded = 0;
    if (existingRefunds.length > 0) {
      previouslyRefunded = existingRefunds.reduce((sum: number, r: any) => sum + (r.amountRefunded || 0), 0);
    }

    // Calculate the new refund amount (incremental)
    const newRefundAmount = refundedAmount - previouslyRefunded;

    if (newRefundAmount <= 0) {
      console.log('[Stripe Webhook] No new refund amount to process');
      return;
    }

    const newRefundPercentage = newRefundAmount / totalAmount;

    console.log('[Stripe Webhook] New refund amount:', newRefundAmount, 'GBP');

    // Find all completed payouts for this order
    const payouts = await queryCollection('payouts', {
      filters: [
        { field: 'orderId', op: 'EQUAL', value: orderId },
        { field: 'status', op: 'EQUAL', value: 'completed' }
      ],
      limit: 50
    });

    if (payouts.length === 0) {
      console.log('[Stripe Webhook] No completed payouts found for order:', orderId);

      // Check for pending payouts and cancel them
      const pendingPayouts = await queryCollection('pendingPayouts', {
        filters: [
          { field: 'orderId', op: 'EQUAL', value: orderId },
          { field: 'status', op: 'IN', value: ['awaiting_connect', 'retry_pending'] }
        ],
        limit: 50
      });

      for (const pending of pendingPayouts) {
        await updateDocument('pendingPayouts', pending.id, {
          status: 'cancelled',
          cancelledReason: 'order_refunded',
          refundPercentage: refundPercentage,
          updatedAt: new Date().toISOString()
        });
        console.log('[Stripe Webhook] Cancelled pending payout:', pending.id);
      }

      // Record the refund even without transfers to reverse
      await addDocument('refunds', {
        stripeChargeId: charge.id,
        stripePaymentIntentId: paymentIntentId,
        orderId: orderId,
        orderNumber: order.orderNumber || '',
        totalAmount: totalAmount,
        amountRefunded: refundedAmount,
        refundPercentage: refundPercentage,
        isFullRefund: isFullRefund,
        transfersReversed: [],
        pendingPayoutsCancelled: pendingPayouts.length,
        createdAt: new Date().toISOString()
      });

      return;
    }

    console.log('[Stripe Webhook] Found', payouts.length, 'payouts to process');

    // Reverse transfers proportionally
    let transfersReversed: any[] = [];
    let totalReversed = 0;

    for (const payout of payouts) {
      if (!payout.stripeTransferId) continue;

      // Calculate proportional reversal amount
      const reversalAmount = Math.round(payout.amount * newRefundPercentage * 100) / 100;

      if (reversalAmount <= 0) continue;

      try {
        // Get the transfer to check current state
        const transfer = await stripe.transfers.retrieve(payout.stripeTransferId);

        // Calculate how much can still be reversed
        const alreadyReversed = (transfer.amount_reversed || 0) / 100;
        const transferAmount = transfer.amount / 100;
        const remainingReversible = transferAmount - alreadyReversed;

        if (remainingReversible <= 0) {
          console.log('[Stripe Webhook] Transfer already fully reversed:', payout.stripeTransferId);
          continue;
        }

        // Don't reverse more than what's available
        const actualReversalAmount = Math.min(reversalAmount, remainingReversible);
        const reversalAmountCents = Math.round(actualReversalAmount * 100);

        if (reversalAmountCents <= 0) continue;

        // Create transfer reversal
        const reversal = await stripe.transfers.createReversal(payout.stripeTransferId, {
          amount: reversalAmountCents,
          metadata: {
            reason: 'customer_refund',
            orderId: orderId,
            chargeId: charge.id,
            refundPercentage: (newRefundPercentage * 100).toFixed(1)
          }
        });

        transfersReversed.push({
          transferId: payout.stripeTransferId,
          reversalId: reversal.id,
          amount: actualReversalAmount,
          artistId: payout.artistId,
          artistName: payout.artistName
        });

        totalReversed += actualReversalAmount;

        console.log('[Stripe Webhook] ✓ Reversed', actualReversalAmount, 'GBP from', payout.artistName);

        // Update payout record
        const currentReversed = payout.reversedAmount || 0;
        const newTotalReversed = currentReversed + actualReversalAmount;
        const isFullyReversed = newTotalReversed >= payout.amount * 0.99;

        await updateDocument('payouts', payout.id, {
          status: isFullyReversed ? 'reversed' : 'partially_reversed',
          reversedAmount: newTotalReversed,
          reversedAt: new Date().toISOString(),
          reversalReason: 'customer_refund',
          refundChargeId: charge.id,
          updatedAt: new Date().toISOString()
        });

        // Update artist's total earnings
        if (payout.artistId) {
          const artist = await getDocument('artists', payout.artistId);
          if (artist) {
            await updateDocument('artists', payout.artistId, {
              totalEarnings: Math.max(0, (artist.totalEarnings || 0) - actualReversalAmount),
              updatedAt: new Date().toISOString()
            });
          }
        }

      } catch (reversalError: any) {
        console.error('[Stripe Webhook] Failed to reverse transfer:', payout.stripeTransferId, reversalError.message);

        // Record failed reversal for manual review
        transfersReversed.push({
          transferId: payout.stripeTransferId,
          error: reversalError.message,
          amount: reversalAmount,
          artistId: payout.artistId,
          artistName: payout.artistName,
          failed: true
        });
      }
    }

    // Also cancel any pending payouts
    const pendingPayouts = await queryCollection('pendingPayouts', {
      filters: [
        { field: 'orderId', op: 'EQUAL', value: orderId },
        { field: 'status', op: 'IN', value: ['awaiting_connect', 'retry_pending'] }
      ],
      limit: 50
    });

    for (const pending of pendingPayouts) {
      if (isFullRefund) {
        // Full refund - cancel entirely
        await updateDocument('pendingPayouts', pending.id, {
          status: 'cancelled',
          cancelledReason: 'order_refunded',
          updatedAt: new Date().toISOString()
        });
      } else {
        // Partial refund - reduce amount proportionally
        const reducedAmount = pending.amount * (1 - newRefundPercentage);
        await updateDocument('pendingPayouts', pending.id, {
          amount: Math.round(reducedAmount * 100) / 100,
          originalAmount: pending.amount,
          reducedByRefund: true,
          refundPercentage: newRefundPercentage,
          updatedAt: new Date().toISOString()
        });
      }
    }

    // Create refund record
    await addDocument('refunds', {
      stripeChargeId: charge.id,
      stripePaymentIntentId: paymentIntentId,
      orderId: orderId,
      orderNumber: order.orderNumber || '',
      totalAmount: totalAmount,
      amountRefunded: refundedAmount,
      newRefundAmount: newRefundAmount,
      refundPercentage: refundPercentage,
      isFullRefund: isFullRefund,
      transfersReversed: transfersReversed,
      totalReversed: totalReversed,
      pendingPayoutsAffected: pendingPayouts.length,
      createdAt: new Date().toISOString()
    });

    // Update order status
    await updateDocument('orders', orderId, {
      refundStatus: isFullRefund ? 'fully_refunded' : 'partially_refunded',
      refundAmount: refundedAmount,
      refundedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    console.log('[Stripe Webhook] ✓ Refund processed. Reversed', totalReversed, 'GBP from', transfersReversed.filter((t: any) => !t.failed).length, 'transfers');

    // Send email notifications to affected artists
    for (const reversal of transfersReversed) {
      if (reversal.failed) continue;

      // Get artist email
      const artist = await getDocument('artists', reversal.artistId);
      if (artist?.email) {
        // Find original payout amount
        const payout = payouts.find((p: any) => p.stripeTransferId === reversal.transferId);
        const originalAmount = payout?.amount || reversal.amount;

        sendRefundNotificationEmail(
          artist.email,
          reversal.artistName || artist.artistName,
          reversal.amount,
          originalAmount,
          order.orderNumber || orderId.slice(-6).toUpperCase(),
          isFullRefund,
          env
        ).catch(err => console.error('[Stripe Webhook] Failed to send refund notification email:', err));
      }
    }

  } catch (error: any) {
    console.error('[Stripe Webhook] Error handling refund:', error.message);
  }
}
