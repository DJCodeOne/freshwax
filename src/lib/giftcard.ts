// src/lib/giftcard.ts
// Gift Card System - Generate, validate, and redeem gift cards

import { escapeHtml, fetchWithTimeout } from './api-utils';
import { SITE_URL } from './constants';
import { sendResendEmail } from './email';
import { emailWrapper, ctaButton, esc } from './email-wrapper';

/**
 * Get cryptographically secure random bytes
 * Works in both Node.js and browser environments
 */
function getSecureRandomBytes(length: number): Uint8Array {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    // Browser or modern Node.js
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  }
  // Fallback should never happen in production, but included for safety
  throw new Error('No secure random source available');
}

/**
 * Generate a unique gift card code using cryptographically secure random
 * Format: FWGC-XXXX-XXXX-XXXX (16 chars total)
 */
export function generateGiftCardCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing chars (0,O,1,I)
  const segments: string[] = [];

  // Get enough random bytes for all 12 characters
  const randomBytes = getSecureRandomBytes(12);

  for (let s = 0; s < 3; s++) {
    let segment = '';
    for (let i = 0; i < 4; i++) {
      const byteIndex = s * 4 + i;
      // Use modulo to map byte value to character index
      segment += chars[randomBytes[byteIndex] % chars.length];
    }
    segments.push(segment);
  }

  return `FWGC-${segments.join('-')}`;
}

/**
 * Validate gift card code format
 */
export function isValidCodeFormat(code: string): boolean {
  const pattern = /^FWGC-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
  return pattern.test(code.toUpperCase().trim());
}

/**
 * Format currency for UK display
 */
export function formatGBP(amount: number): string {
  return `£${amount.toFixed(2)}`;
}

/**
 * Gift card types
 */
export type GiftCardType = 'welcome' | 'promotional' | 'purchased' | 'refund' | 'referral';

export interface GiftCard {
  id?: string;
  code: string;
  originalValue: number;
  currentBalance: number;
  type: GiftCardType;
  createdAt: string;
  expiresAt: string | null;
  redeemedBy: string | null;
  redeemedAt: string | null;
  isActive: boolean;
  description: string;
  createdFor?: string; // email or userId it was created for (optional)
  createdByUserId?: string; // userId of the person who generated this (for referrals)
  restrictedTo?: 'pro_upgrade'; // If set, this gift card can only be used for specific purposes
}

export interface UserCredit {
  balance: number;
  lastUpdated: string;
  transactions: CreditTransaction[];
}

export interface CreditTransaction {
  id: string;
  type: 'gift_card_redemption' | 'purchase' | 'refund' | 'adjustment';
  amount: number; // positive for credit, negative for debit
  description: string;
  giftCardCode?: string;
  orderId?: string;
  createdAt: string;
  balanceAfter: number;
}

/**
 * Calculate expiry date (1 year from now by default)
 */
export function getDefaultExpiry(): string {
  const date = new Date();
  date.setFullYear(date.getFullYear() + 1);
  return date.toISOString();
}

/**
 * Check if gift card is expired
 */
export function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt) < new Date();
}

/**
 * Generate welcome gift card for new users
 */
export function createWelcomeGiftCard(userEmail?: string): Omit<GiftCard, 'id'> {
  return {
    code: generateGiftCardCode(),
    originalValue: 50.00,
    currentBalance: 50.00,
    type: 'welcome',
    createdAt: new Date().toISOString(),
    expiresAt: getDefaultExpiry(),
    redeemedBy: null,
    redeemedAt: null,
    isActive: true,
    description: '£50 Welcome Gift Card - Thank you for joining Fresh Wax!',
    createdFor: userEmail
  };
}

/**
 * Create a promotional gift card
 */
export function createPromotionalGiftCard(
  value: number,
  description: string,
  createdFor?: string
): Omit<GiftCard, 'id'> {
  return {
    code: generateGiftCardCode(),
    originalValue: value,
    currentBalance: value,
    type: 'promotional',
    createdAt: new Date().toISOString(),
    expiresAt: getDefaultExpiry(),
    redeemedBy: null,
    redeemedAt: null,
    isActive: true,
    description,
    createdFor
  };
}

/**
 * Create a referral gift card (50% off Pro upgrade)
 * Can only be used for Pro subscription upgrades
 */
export function createReferralGiftCard(
  referrerUserId: string,
  referrerName?: string
): Omit<GiftCard, 'id'> {
  const REFERRAL_DISCOUNT = 5; // £5 off (50% of £10 Pro price)

  return {
    code: generateGiftCardCode(),
    originalValue: REFERRAL_DISCOUNT,
    currentBalance: REFERRAL_DISCOUNT,
    type: 'referral',
    createdAt: new Date().toISOString(),
    expiresAt: getDefaultExpiry(),
    redeemedBy: null,
    redeemedAt: null,
    isActive: true,
    description: referrerName
      ? `£${REFERRAL_DISCOUNT} referral discount from ${referrerName} - Valid for Pro upgrade only`
      : `£${REFERRAL_DISCOUNT} referral discount - Valid for Pro upgrade only`,
    createdByUserId: referrerUserId,
    restrictedTo: 'pro_upgrade'
  };
}

/**
 * Referral discount amount
 */
export const REFERRAL_DISCOUNT_AMOUNT = 5; // £5

/**
 * Gift card purchase data (for creating after payment)
 */
export interface GiftCardPurchaseData {
  amount: number;
  buyerUserId: string;
  buyerEmail: string;
  buyerName: string;
  recipientType: 'gift' | 'self';
  recipientName: string;
  recipientEmail: string;
  message: string;
  paymentIntentId?: string; // Stripe payment intent
  paypalOrderId?: string; // PayPal order ID
}


/**
 * Send gift card email via Resend API
 */
export async function sendGiftCardEmail(
  toEmail: string,
  toName: string,
  code: string,
  amount: number,
  isGift: boolean,
  senderName: string,
  message: string
): Promise<boolean> {
  const RESEND_API_KEY = import.meta.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.error('[giftcard] No Resend API key configured');
    return false;
  }

  try {
    const subject = isGift
      ? `You've received a £${amount} Fresh Wax Gift Card!`
      : `Your £${amount} Fresh Wax Gift Card`;

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

    const result = await sendResendEmail({
      apiKey: RESEND_API_KEY,
      from: 'Fresh Wax <noreply@freshwax.co.uk>',
      to: toEmail,
      subject,
      html,
      template: 'gift-card',
    });

    return result.success;
  } catch (error: unknown) {
    console.error('[giftcard] Email send error:', error);
    return false;
  }
}

/**
 * Create gift card after successful payment
 * This is the shared function used by both Stripe webhook and PayPal capture
 */
export interface CreateGiftCardResult {
  success: boolean;
  giftCard?: {
    id: string;
    code: string;
    amount: number;
    recipientEmail: string;
  };
  error?: string;
  emailSent?: boolean;
}

export async function createGiftCardAfterPayment(
  data: GiftCardPurchaseData,
  firebaseOps: {
    queryCollection: (collection: string, options: any) => Promise<any[]>;
    addDocument: (collection: string, data: any) => Promise<{ id: string }>;
    updateDocument: (collection: string, id: string, data: any) => Promise<void>;
    getDocument: (collection: string, id: string) => Promise<any>;
  }
): Promise<CreateGiftCardResult> {
  const { queryCollection, addDocument, updateDocument, getDocument } = firebaseOps;

  try {
    // Generate unique code
    let code = generateGiftCardCode();
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

    // Get buyer name from user doc if not provided
    let buyerName = data.buyerName;
    if (!buyerName) {
      try {
        const buyerDoc = await getDocument('users', data.buyerUserId);
        if (buyerDoc) {
          buyerName = buyerDoc.displayName || buyerDoc.fullName || buyerDoc.firstName || '';
        }
      } catch (e) {
        // Ignore
      }
    }

    const now = new Date();
    const purchasedAt = now.toISOString();
    const isGift = data.recipientType === 'gift';
    const targetEmail = isGift ? data.recipientEmail : data.buyerEmail;

    // Create gift card document
    const giftCard = {
      code,
      originalValue: data.amount,
      currentBalance: data.amount,
      type: isGift ? 'gift' : 'purchased',
      description: isGift
        ? `Gift card from ${buyerName || data.buyerEmail}`
        : 'Purchased gift card',
      createdAt: purchasedAt,
      expiresAt: null, // Actual expiry set on redemption
      isActive: true,
      redeemedBy: null,
      redeemedAt: null,

      // Purchase info
      purchasedBy: data.buyerUserId,
      purchasedByEmail: data.buyerEmail,
      purchasedByName: buyerName,
      recipientEmail: targetEmail,
      recipientName: data.recipientName || '',
      giftMessage: data.message || '',

      // Payment tracking
      paymentIntentId: data.paymentIntentId || null,
      paypalOrderId: data.paypalOrderId || null,

      // Email tracking
      emailsSent: []
    };

    const giftCardResult = await addDocument('giftCards', giftCard);
    console.log(`[giftcard] Created gift card ${code} for £${data.amount}`);

    // Store purchase record in customer's account
    const displayExpiryDate = new Date(now);
    displayExpiryDate.setFullYear(displayExpiryDate.getFullYear() + 1);
    const displayExpiresAt = displayExpiryDate.toISOString();

    const purchaseRecordId = `purchase_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      await fetchWithTimeout(
        `https://firestore.googleapis.com/v1/projects/freshwax-store/databases/(default)/documents/users/${data.buyerUserId}/purchasedGiftCards?documentId=${purchaseRecordId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fields: {
              giftCardId: { stringValue: giftCardResult.id },
              amount: { integerValue: String(data.amount) },
              recipientEmail: { stringValue: targetEmail },
              recipientName: { stringValue: data.recipientName || '' },
              recipientType: { stringValue: data.recipientType },
              purchasedAt: { stringValue: purchasedAt },
              displayExpiresAt: { stringValue: displayExpiresAt },
              status: { stringValue: 'sent' }
            }
          })
        },
        10000
      );
      console.log(`[giftcard] Added purchase record to customer ${data.buyerUserId}`);
    } catch (e) {
      console.error('[giftcard] Failed to add purchase record:', e);
    }

    // Send email to recipient
    const emailSent = await sendGiftCardEmail(
      targetEmail,
      data.recipientName || '',
      code,
      data.amount,
      isGift,
      buyerName,
      data.message || ''
    );

    // Update email tracking
    if (emailSent) {
      await updateDocument('giftCards', giftCardResult.id, {
        emailsSent: [
          { email: targetEmail, sentAt: new Date().toISOString(), type: 'recipient' }
        ]
      });
    }

    return {
      success: true,
      giftCard: {
        id: giftCardResult.id,
        code,
        amount: data.amount,
        recipientEmail: targetEmail
      },
      emailSent
    };

  } catch (error: unknown) {
    console.error('[giftcard] Error creating gift card:', error);
    return {
      success: false,
      error: 'Failed to create gift card'
    };
  }
}
