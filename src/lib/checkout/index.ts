/**
 * Checkout barrel — re-exports all checkout sub-modules.
 */
export { createCheckoutState } from './state';
export type { CheckoutState } from './state';

export {
  showError,
  hideError,
  validateField,
  validateAllFields,
  setupFieldValidation,
  getCustomerIdFromCookie,
  loadCart,
  calculateTotals,
  checkDuplicatePurchases,
  removeDuplicatesFromCart,
  loadCustomerData,
  loadCreditBalance,
  checkUserType,
} from './validation';

export {
  toggleApplyCredit,
  updateCreditDisplay,
  updatePaymentButtonText,
  getBadgeStyle,
  lookupPostcode,
  showAccessDenied,
  renderCheckout,
} from './ui';

export {
  handleStripeSubmit,
} from './stripe';

export {
  handleCustomPayPalClick,
  renderPayPalButtons,
  selectPaymentMethod,
  setupPaymentMethods,
  resetPayPalButton,
} from './paypal';
