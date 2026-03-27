// src/lib/checkout/types.ts
// Shared state and types for the checkout module

import type { createClientLogger } from '../client-logger';

/** Firebase Auth user shape available on the client (subset of Firebase User) */
export interface CheckoutFirebaseUser {
  uid: string;
  email?: string | null;
  displayName?: string | null;
  getIdToken: () => Promise<string>;
}

/** Customer data returned by /api/checkout-data/ for form pre-fill */
export interface CheckoutCustomerData {
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  phone?: string;
  address1?: string;
  addressLine1?: string;
  address2?: string;
  addressLine2?: string;
  city?: string;
  county?: string;
  postcode?: string;
  country?: string;
}

/** A duplicate purchase found by /api/check-duplicates/ */
export interface DuplicateResult {
  item: CartItem;
  reason: string;
}

/** An unavailable item reported back from the checkout session API */
export interface UnavailableItem {
  name: string;
  reason?: string;
}

/** Shared mutable state passed between checkout sub-modules */
export interface CheckoutState {
  currentUser: CheckoutFirebaseUser | null;
  customerData: CheckoutCustomerData | null;
  cart: CartItem[];
  creditBalance: number;
  creditExpiry: Date | null;
  appliedCredit: number;
  creditLoaded: boolean;
  selectedPaymentMethod: string;
  paypalButtonsRendered: boolean;
  userTypeChecked: boolean;
  isAllowedToBuy: boolean;
  duplicatePurchases: DuplicateResult[];
  authInitialized: boolean;
  logger: ReturnType<typeof createClientLogger>;
}
