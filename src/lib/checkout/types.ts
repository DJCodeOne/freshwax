// src/lib/checkout/types.ts
// Shared state and types for the checkout module

import type { createClientLogger } from '../client-logger';

/** Shared mutable state passed between checkout sub-modules */
export interface CheckoutState {
  currentUser: any;
  customerData: any;
  cart: any[];
  creditBalance: number;
  creditExpiry: Date | null;
  appliedCredit: number;
  creditLoaded: boolean;
  selectedPaymentMethod: string;
  paypalButtonsRendered: boolean;
  userTypeChecked: boolean;
  isAllowedToBuy: boolean;
  duplicatePurchases: any[];
  authInitialized: boolean;
  logger: ReturnType<typeof createClientLogger>;
}
