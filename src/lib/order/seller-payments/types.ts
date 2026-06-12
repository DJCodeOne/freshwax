// src/lib/order/seller-payments/types.ts
// Shared types for seller payment processing

/** Params shared by all seller payment functions */
export interface SellerPaymentParams {
  orderId: string;
  orderNumber: string;
  items: Record<string, unknown>[];
  totalItemCount: number;
  orderSubtotal: number;
  stripeSecretKey: string;
  env: Record<string, unknown>;
  /** Optional log prefix override (e.g. '[PayPal]' or '[PayPal Redirect]') */
  logPrefix?: string;
  /**
   * Payment method used for the order. Drives the processing-fee formula
   * deducted from each seller's share. Defaults to 'stripe'. PayPal charges
   * higher fees than Stripe (~2.9% + £0.30 vs 1.4% + £0.20) — using the
   * wrong rate causes Fresh Wax to over-pay sellers and absorb the gap.
   */
  paymentMethod?: 'stripe' | 'paypal' | string;
  /**
   * ACTUAL processor fee for this payment (e.g. PayPal capture
   * seller_receivable_breakdown.paypal_fee, Stripe balance transaction fee).
   * Sellers bear the real fee — when provided this replaces the
   * getProcessingFee() estimate.
   */
  actualProcessingFee?: number | null;
  /**
   * Per-artist vinyl shipping (artists receive 100% of their shipping fee
   * on top of the item share). Keyed by artistId. Stored on the pending
   * checkout/order at create time.
   */
  artistShippingBreakdown?: Record<string, { artistId: string; artistName: string; amount: number }> | null;
}

/**
 * Per-payment-method processing fee parameters (UK GBP).
 * Stripe: 1.4% + 20p domestic.
 * PayPal Commercial: 2.9% + 30p.
 */
export const PROCESSING_FEE_RATES = {
  stripe: { rate: 0.014, fixed: 0.20 },
  paypal: { rate: 0.029, fixed: 0.30 },
} as const;

/**
 * Compute the per-order processing fee that should be deducted from
 * the sellers' combined share. Defaults to Stripe rates if the payment
 * method isn't recognised.
 */
export function getProcessingFee(orderSubtotal: number, paymentMethod?: string): number {
  const key = paymentMethod === 'paypal' ? 'paypal' : 'stripe';
  const { rate, fixed } = PROCESSING_FEE_RATES[key];
  return (orderSubtotal * rate) + fixed;
}
