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
}
