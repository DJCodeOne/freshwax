// src/pages/api/giftcards/purchase.ts
// Admin-only endpoint to create promotional/complimentary gift cards
// For customer purchases, use create-stripe-session.ts or create-paypal-order.ts

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, addDocument, queryCollection } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { requireAdminAuth } from '../../../lib/admin';
import { generateGiftCardCode } from '../../../lib/giftcard';
import { getServiceAccountToken } from '../../../lib/firebase-service-account';
import { SITE_URL } from '../../../lib/constants';
import { fetchWithTimeout, ApiErrors, createLogger } from '../../../lib/api-utils';

const log = createLogger('[purchase]');
import { emailWrapper, ctaButton, esc } from '../../../lib/email-wrapper';

// Zod schema for admin gift card creation
const AdminGiftCardSchema = z.object({
  amount: z.union([z.number(), z.string()]).refine(val => {
    const num = typeof val === 'string' ? parseInt(val) : val;
    return num >= 5 && num <= 500;
  }, 'Amount must be between 5 and 500'),
  buyerUserId: z.string().min(1, 'Buyer user ID required'),
  buyerEmail: z.string().email('Valid buyer email required'),
  recipientType: z.enum(['self', 'gift']).optional(),
  recipientName: z.string().max(200).optional(),
  recipientEmail: z.string().email().optional(),
  message: z.string().max(500).optional(),
}).passthrough();



// Send email via Resend API (using fetch for Cloudflare compatibility)
async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const RESEND_API_KEY = import.meta.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    log.error('[giftcards/purchase] No Resend API key configured');
    return false;
  }

  try {
    const response = await fetchWithTimeout('https://api.resend.com/emails', {
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
    }, 10000);

    if (!response.ok) {
      const error = await response.text();
      log.error('[giftcards/purchase] Resend error:', response.status, error);
      return false;
    }

    return true;
  } catch (error: unknown) {
    log.error('[giftcards/purchase] Email send error:', error);
    return false;
  }
}

// Gift card code generation imported from lib/giftcard.ts (uses crypto.getRandomValues)

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

    const safeSenderName = esc(senderName);
    const safeMessage = esc(message);

    const giftSection = isGift && senderName ? `
      <p style="font-size: 16px; color: #6b7280;" class="light-text-secondary">
        <strong style="color: #111111;" class="light-text">${safeSenderName}</strong> has sent you a gift!
      </p>
      ${message ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 20px 0;">
        <tr>
          <td style="background: #f5f5f5; border-left: 4px solid #dc2626; padding: 15px 20px; border-radius: 0 8px 8px 0;" class="light-detail-box">
            <p style="font-size: 16px; color: #333333; margin: 0; font-style: italic;" class="light-text">&ldquo;${safeMessage}&rdquo;</p>
          </td>
        </tr>
      </table>
      ` : ''}
    ` : '';

    const giftCardContent = `
              <h2 style="font-size: 28px; color: #111111; text-align: center; margin: 0 0 20px 0;" class="light-text">
                ${isGift ? "You've Received a Gift Card!" : 'Your Gift Card is Ready!'}
              </h2>

              ${giftSection}

              <!-- Gift Card Box -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 30px 0;">
                <tr>
                  <td style="background: linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 100%); border-radius: 16px; padding: 30px; text-align: center;">
                    <p style="color: #888; font-size: 14px; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 10px 0;">Gift Card Value</p>
                    <p style="font-size: 48px; color: #dc2626; font-weight: 700; margin: 0 0 20px 0;">\u00a3${amount}</p>
                    <p style="color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 10px 0;">Your Redemption Code</p>
                    <table role="presentation" cellpadding="0" cellspacing="0" align="center">
                      <tr>
                        <td style="background: #111; border: 2px solid #dc2626; border-radius: 10px; padding: 15px 25px;">
                          <code style="font-size: 24px; color: #fff; letter-spacing: 3px; font-family: 'Monaco', 'Consolas', monospace;">${esc(code)}</code>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- How to Use -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 30px 0;">
                <tr>
                  <td style="background: #f9f9f9; border-radius: 12px; padding: 25px;" class="light-detail-box">
                    <h3 style="font-size: 18px; color: #111111; margin: 0 0 15px 0;" class="light-text">How to Redeem</h3>
                    <ol style="color: #6b7280; font-size: 15px; line-height: 1.8; margin: 0; padding-left: 20px;" class="light-text-secondary">
                      <li>Visit <a href="${SITE_URL}/giftcards/" style="color: #dc2626;">freshwax.co.uk/giftcards</a></li>
                      <li>Sign in or create an account</li>
                      <li>Enter your code above</li>
                      <li>Start shopping!</li>
                    </ol>
                  </td>
                </tr>
              </table>

              ${ctaButton('Redeem Your Gift Card', SITE_URL + '/giftcards/')}

              <p style="color: #9ca3af; font-size: 13px; text-align: center; margin: 0;" class="light-text-secondary">
                Your gift card credit never expires. Use it to buy digital releases, vinyl records, and merchandise.
              </p>`;

    const html = emailWrapper(giftCardContent, {
      title: isGift ? "You've Received a Gift Card!" : 'Your Gift Card is Ready!',
      hideHeader: true,
      lightTheme: true,
      footerBrand: 'Fresh Wax - Underground Jungle & Drum and Bass',
    });

    const sent = await sendEmail(toEmail, subject, html);

    if (sent) {
      log.info(`[giftcards/purchase] Email sent to ${toEmail}`);
    }
    return sent;
  } catch (error: unknown) {
    log.error('[giftcards/purchase] Email error:', error);
    return false;
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`giftcard-purchase:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const rawBody = await request.json();

    // SECURITY: Require admin authentication
    const authError = await requireAdminAuth(request, locals, rawBody);
    if (authError) {
      return authError;
    }

    // Zod input validation
    const parseResult = AdminGiftCardSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const data = parseResult.data;
    const {
      amount,
      buyerUserId,
      buyerEmail,
      recipientType,
      recipientName,
      recipientEmail,
      message
    } = data;

    const numAmount = parseInt(String(amount));

    // Validate recipient email
    const targetEmail = recipientType === 'gift' ? recipientEmail : buyerEmail;
    if (!targetEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
      return ApiErrors.badRequest('Invalid recipient email address');
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
      const buyerDoc = await getDocument('users', buyerUserId);
      if (buyerDoc) {
        buyerName = buyerDoc.displayName || buyerDoc.fullName || buyerDoc.firstName || '';
      }
    } catch (e: unknown) {
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
    log.info(`[giftcards/purchase] Created gift card ${code} for £${numAmount}`);

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
    try {
      // Build service account key from env for authenticated Firestore write
      const env = locals.runtime.env;
      const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
      const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;
      const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

      let authHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (clientEmail && privateKey) {
        const serviceAccountKey = JSON.stringify({
          type: 'service_account',
          project_id: projectId,
          private_key_id: 'auto',
          private_key: privateKey.replace(/\\n/g, '\n'),
          client_email: clientEmail,
          client_id: '',
          auth_uri: 'https://accounts.google.com/o/oauth2/auth',
          token_uri: 'https://oauth2.googleapis.com/token'
        });
        const saToken = await getServiceAccountToken(serviceAccountKey);
        authHeaders['Authorization'] = 'Bearer ' + saToken;
      }

      const subcollectionResponse = await fetchWithTimeout(
        `https://firestore.googleapis.com/v1/projects/freshwax-store/databases/(default)/documents/users/${buyerUserId}/purchasedGiftCards?documentId=${purchaseRecordId}`,
        {
          method: 'POST',
          headers: authHeaders,
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
        },
        10000
      );

      if (!subcollectionResponse.ok) {
        const errorText = await subcollectionResponse.text();
        log.error(`[giftcards/purchase] Failed to add purchase record: ${subcollectionResponse.status}`, errorText);
      } else {
        log.info(`[giftcards/purchase] Added purchase record to customer ${buyerUserId}`);
      }
    } catch (purchaseRecordErr: unknown) {
      // Non-critical: gift card already created, just log the error
      log.error('[giftcards/purchase] Failed to store purchase record:', purchaseRecordErr);
    }

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

    return successResponse({ giftCard: {
        code,
        amount: numAmount,
        recipientEmail: targetEmail,
        purchasedAt,
        expiresAt: displayExpiresAt
      },
      emailSent: recipientEmailSent });

  } catch (error: unknown) {
    log.error('[giftcards/purchase] Error:', error);
    return ApiErrors.serverError('Failed to create gift card');
  }
};
