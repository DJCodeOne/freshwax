// src/lib/giftcard.ts
// Gift Card System - Generate, validate, and redeem gift cards

/**
 * Generate a unique gift card code
 * Format: FWGC-XXXX-XXXX-XXXX (16 chars total)
 */
export function generateGiftCardCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing chars (0,O,1,I)
  const segments: string[] = [];
  
  for (let s = 0; s < 3; s++) {
    let segment = '';
    for (let i = 0; i < 4; i++) {
      segment += chars[Math.floor(Math.random() * chars.length)];
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
