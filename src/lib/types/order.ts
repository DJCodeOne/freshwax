// src/lib/types/order.ts
// Order, commerce, payout, and dispute types

import type { Timestamps } from './base';

// ============================================
// ORDERS & COMMERCE
// ============================================

export type OrderStatus = 'pending' | 'paid' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';

export interface Order extends Timestamps {
  id: string;
  customerId: string;
  artistId?: string;

  // Customer
  customer: OrderCustomer;
  shipping: OrderAddress;

  // Items
  items: OrderItem[];

  // Pricing
  subtotal: number;
  shippingCost: number;
  discount?: number;
  total: number;

  // Payment
  status: OrderStatus;
  paymentIntentId?: string;
  paidAt?: string;

  // Shipping
  trackingNumber?: string;
  shippedAt?: string;
  deliveredAt?: string;

  // Notes
  notes?: string;
  adminNotes?: string;
}

export interface OrderCustomer {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
}

export interface OrderAddress {
  line1: string;
  line2?: string;
  city: string;
  postcode: string;
  country: string;
}

export interface OrderItem {
  id: string;
  type: 'release' | 'merch' | 'giftcard' | 'track';
  title: string;
  quantity: number;
  price: number;
  artistId?: string;
  size?: string;
  color?: string;
  imageUrl?: string;
}

// ============================================
// API REQUEST/RESPONSE TYPES
// ============================================

export interface ApiSuccess<T = unknown> {
  success: true;
  data?: T;
  message?: string;
}

export interface ApiError {
  error: string;
  code?: string;
  details?: unknown;
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError;

// ============================================
// STRIPE CONNECT PAYOUTS
// ============================================

export type PayoutStatus = 'pending' | 'completed' | 'failed' | 'reversed';

export interface Payout extends Timestamps {
  id: string;
  artistId: string;
  artistName: string;
  artistEmail: string;
  stripeConnectId?: string;
  stripeTransferId?: string;          // tr_xxx
  paypalEmail?: string;
  paypalBatchId?: string;
  paypalPayoutItemId?: string;
  payoutMethod?: 'stripe' | 'paypal';

  // Order reference
  orderId: string;
  orderNumber: string;

  // Amount (total = itemAmount + shippingAmount)
  amount: number;                     // Total amount in GBP
  itemAmount?: number;                // Amount for items only
  shippingAmount?: number;            // Amount for vinyl shipping (goes to artist)
  currency: string;

  // Status
  status: PayoutStatus;
  failureReason?: string;
  completedAt?: string;
  reversedAt?: string;
  reversedAmount?: number;
}

export type PendingPayoutStatus = 'awaiting_connect' | 'retry_pending' | 'processing' | 'resolved';

export interface PendingPayout extends Timestamps {
  id: string;
  artistId: string;
  artistName: string;
  artistEmail: string;
  paypalEmail?: string;
  payoutMethod?: 'stripe' | 'paypal';

  // Order reference
  orderId: string;
  orderNumber: string;

  // Amount (total = itemAmount + shippingAmount)
  amount: number;                     // Total amount in GBP
  itemAmount?: number;                // Amount for items only
  shippingAmount?: number;            // Amount for vinyl shipping (goes to artist)
  currency: string;

  // Status
  status: PendingPayoutStatus;
  failureReason?: string;
  originalPayoutId?: string;          // If this is a retry from failed payout
  notificationSent?: boolean;
  resolvedAt?: string;
  resolvedPayoutId?: string;          // Link to successful payout when resolved
}

// ============================================
// DISPUTES
// ============================================

export type DisputeStatus = 'open' | 'won' | 'lost' | 'closed';

export interface Dispute extends Timestamps {
  id: string;
  stripeDisputeId: string;            // dp_xxx
  stripeChargeId: string;             // ch_xxx
  stripePaymentIntentId?: string;     // pi_xxx

  // Order reference
  orderId?: string;
  orderNumber?: string;

  // Artist info (if transfer was reversed)
  artistId?: string;
  artistName?: string;
  transferId?: string;                // tr_xxx - the transfer that was reversed
  transferReversalId?: string;        // trr_xxx

  // Amounts
  amount: number;                     // Disputed amount in GBP
  currency: string;
  amountRecovered?: number;           // Amount recovered from artist

  // Dispute details
  reason: string;                     // e.g., 'fraudulent', 'product_not_received'
  status: DisputeStatus;
  evidenceDueBy?: string;

  // Resolution
  resolvedAt?: string;
  outcome?: 'won' | 'lost';
  netImpact?: number;                 // Final financial impact to platform
}
