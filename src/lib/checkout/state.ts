/**
 * Shared checkout state — passed between checkout sub-modules.
 * All mutable state lives here so closure variables are not needed.
 */
export interface CheckoutState {
  currentUser: FirebaseAuthUser | null;
  customerData: CustomerData | null;
  cart: CartItem[];
  creditBalance: number;
  creditExpiry: Date | null;
  appliedCredit: number;
  creditLoaded: boolean;
  selectedPaymentMethod: string;
  paypalButtonsRendered: boolean;
  paypalSDKLoaded: boolean;
  userTypeChecked: boolean;
  isAllowedToBuy: boolean;
  duplicatePurchases: DuplicatePurchase[];
  authInitialized: boolean;
}

export function createCheckoutState(): CheckoutState {
  return {
    currentUser: null,
    customerData: null,
    cart: [],
    creditBalance: 0,
    creditExpiry: null,
    appliedCredit: 0,
    creditLoaded: false,
    selectedPaymentMethod: 'stripe',
    paypalButtonsRendered: false,
    paypalSDKLoaded: false,
    userTypeChecked: false,
    isAllowedToBuy: true,
    duplicatePurchases: [],
    authInitialized: false,
  };
}
