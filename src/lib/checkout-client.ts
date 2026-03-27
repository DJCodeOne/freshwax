// src/lib/checkout-client.ts
// Thin orchestrator — imports from ./checkout/ sub-modules
// Heavy logic lives in: cart-validation.ts, checkout-ui.ts, stripe-client.ts, paypal-client.ts

import { createClientLogger } from './client-logger';
import { TIMEOUTS } from './timeouts';
import type { CheckoutState } from './checkout/types';
import {
  getCustomerIdFromCookie,
  loadCart,
  loadCreditBalance,
  loadCustomerData,
  checkDuplicatePurchases,
  removeDuplicatesFromCart,
  checkUserType,
} from './checkout/cart-validation';
import {
  showError,
  hideError,
  setupFieldValidation,
  renderCheckout,
  showAccessDenied,
  lookupPostcode,
  toggleApplyCredit,
} from './checkout/checkout-ui';
import { handleSubmit } from './checkout/stripe-client';
import {
  selectPaymentMethod,
  setupPaymentMethods,
  handleCustomPayPalClick,
  setupPayPalClickDelegation,
  setupPageShowHandler,
} from './checkout/paypal-client';

// Re-export everything from sub-modules for backward compatibility
export * from './checkout/index';

const logger = createClientLogger('Checkout');

export function init() {
  // LIGHTWEIGHT AUTH: Uses window.firebaseAuth + window.authReady from Header.astro
  // instead of importing ~200KB Firebase SDK. Customer data loaded via /api/checkout-data.

  // Shared mutable state object passed to all sub-modules
  const state: CheckoutState = {
    currentUser: null,
    customerData: null,
    cart: [],
    creditBalance: 0,
    creditExpiry: null,
    appliedCredit: 0,
    creditLoaded: false,
    selectedPaymentMethod: 'stripe',
    paypalButtonsRendered: false,
    userTypeChecked: false,
    isAllowedToBuy: true,
    duplicatePurchases: [],
    authInitialized: false,
    logger,
  };

  // Wire up field validation
  setupFieldValidation();

  // Callback object for checkout-ui to call back into orchestrator
  const callbacks = {
    lookupPostcode: () => lookupPostcode(state),
    selectPaymentMethod: (method: string) => selectPaymentMethod(state, method),
    toggleApplyCredit: (checked: boolean) => toggleApplyCredit(state, checked),
    handleSubmit: (e: Event) => handleSubmit(e, state),
    removeDuplicatesFromCart: (duplicates: any[]) => removeDuplicatesFromCart(state, duplicates),
    renderCheckout: () => doRenderCheckout(),
    setupPaymentMethods: () => setupPaymentMethods(),
  };

  function doRenderCheckout() {
    loadCart(state);
    renderCheckout(state, callbacks);
  }

  // Document-level click delegation for PayPal button
  setupPayPalClickDelegation(state);

  // Reset buttons when page is restored from bfcache (browser back/forward)
  setupPageShowHandler(state);

  let authInitialized = false;

  // Shared function to initialize checkout with user data
  async function initCheckoutWithUser(user: any, customerId: string | null) {
    authInitialized = true;
    state.authInitialized = true;
    clearTimeout(authTimeout);
    state.currentUser = user;

    const userId = user?.uid || customerId;

    if (userId) {
      // Check if user is allowed to make purchases
      const userType = await checkUserType(state, userId);

      // Artists who are NOT also customers cannot buy
      if (userType.isArtist && !userType.isCustomer) {
        state.isAllowedToBuy = false;
        showAccessDenied();
        return;
      }

      state.customerData = await loadCustomerData(state, userId);

      // Load cart and check for duplicates
      loadCart(state);
      const { duplicates } = await checkDuplicatePurchases(state, userId);
      state.duplicatePurchases = duplicates;

      // Load credit balance for checkout
      await loadCreditBalance(state);
    } else {
      // No user at all - redirect to login
      window.location.href = '/login/?redirect=/checkout/';
      return;
    }

    state.userTypeChecked = true;
    doRenderCheckout();
  }

  // Timeout to handle cases where Firebase auth hangs
  const authTimeout = setTimeout(() => {
    if (!authInitialized) {
      const customerId = getCustomerIdFromCookie();
      if (customerId) {
        initCheckoutWithUser(null, customerId);
      } else {
        window.location.href = '/login/?redirect=/checkout/';
      }
    }
  }, TIMEOUTS.SHORT); // 5 second timeout

  // Use window.authReady from Header.astro instead of importing Firebase Auth SDK
  // Header already loads Firebase Auth and resolves this promise with the user
  if (window.authReady) {
    window.authReady.then(async (user) => {
      // If auth already initialized by timeout, skip
      if (authInitialized) return;

      // If no Firebase auth AND no customerId cookie, redirect to login
      const customerId = getCustomerIdFromCookie();
      if (!user && !customerId) {
        authInitialized = true;
        state.authInitialized = true;
        clearTimeout(authTimeout);
        window.location.href = '/login/?redirect=/checkout/';
        return;
      }

      // Initialize checkout with user/cookie data
      await initCheckoutWithUser(user, customerId);
    });
  } else {
    // Fallback: if authReady not available yet, wait briefly then check cookies
    setTimeout(() => {
      if (!authInitialized) {
        const customerId = getCustomerIdFromCookie();
        if (customerId) {
          initCheckoutWithUser(null, customerId);
        } else {
          window.location.href = '/login/?redirect=/checkout/';
        }
      }
    }, 2000);
  }
}
