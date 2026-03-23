// src/lib/checkout/paypal-client.ts
// PayPal-specific logic: button rendering, order creation, payment capture

import { TIMEOUTS } from '../timeouts';
import type { CheckoutState } from './types';
import { calculateTotals, getCustomerIdFromCookie } from './cart-validation';

export const PAYPAL_CLIENT_ID = import.meta.env.PUBLIC_PAYPAL_CLIENT_ID || 'AZL6pU1E2TbA9DdGgLvljJsON4-IwXIyWsHhQ_Od-BtMXTZTTgThss7pVuZzscyovO1z7XZRKgLRwpmv';

export function loadPayPalSDK() {
  // PayPal button uses document-level click delegation (see bottom of script)
  // No SDK loading needed — custom button calls handleCustomPayPalClick() directly
}

export function selectPaymentMethod(state: CheckoutState, method: string) {
  state.selectedPaymentMethod = method;

  const stripeOption = document.getElementById('stripeOption')!;
  const paypalOption = document.getElementById('paypalOption')!;
  const stripeSection = document.getElementById('stripePaymentSection')!;
  const paypalSection = document.getElementById('paypalPaymentSection')!;

  if (method === 'stripe') {
    stripeOption.style.borderColor = '#dc2626';
    stripeOption.style.background = '#fef2f2';
    paypalOption.style.borderColor = '#d1d5db';
    paypalOption.style.background = '#f9fafb';
    stripeSection.style.display = 'block';
    paypalSection.style.display = 'none';
    const stripeRadio = document.querySelector<HTMLInputElement>('input[name="paymentMethod"][value="stripe"]');
    if (stripeRadio) stripeRadio.checked = true;
  } else {
    paypalOption.style.borderColor = '#dc2626';
    paypalOption.style.background = '#fef2f2';
    stripeOption.style.borderColor = '#d1d5db';
    stripeOption.style.background = '#f9fafb';
    stripeSection.style.display = 'none';
    paypalSection.style.display = 'block';
    const paypalRadio = document.querySelector<HTMLInputElement>('input[name="paymentMethod"][value="paypal"]');
    if (paypalRadio) paypalRadio.checked = true;

    // Load PayPal SDK and render buttons
    loadPayPalSDK();
  }
}

export function setupPaymentMethods() {
  // Set default styling
  const stripeOption = document.getElementById('stripeOption');
  if (stripeOption) {
    stripeOption.style.borderColor = '#dc2626';
    stripeOption.style.background = '#fef2f2';
  }
}

export async function handleCustomPayPalClick(state: CheckoutState) {
  const customBtn = document.getElementById('customPaypalBtn') as HTMLButtonElement;
  const errorMsg = document.getElementById('error-message');

  if (!customBtn || !errorMsg) return;

  // Prevent double-submit
  if (customBtn.disabled) return;

  // Immediate visual feedback so user knows the tap registered
  customBtn.style.opacity = '0.7';

  try {
    // Skip email verification on checkout
    const form = document.getElementById('checkoutForm') as HTMLFormElement;
    const { subtotal, shipping, hasPhysicalItems, freshWaxFee, stripeFee, serviceFees, total } = calculateTotals(state);

    // Check if credit covers entire order - route to free order flow
    const finalTotal = Math.max(0, total - state.appliedCredit);
    if (finalTotal === 0) {
      // Submit form to use free order flow
      form.dispatchEvent(new Event('submit', { cancelable: true }));
      return;
    }

    // Validate form fields
    if (!form.checkValidity()) {
      const firstInvalid = form.querySelector(':invalid') as HTMLElement;
      if (firstInvalid) {
        firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => { try { firstInvalid.focus(); } catch(_e: unknown){ /* intentional: focus may fail if element is not focusable — non-critical */ } }, TIMEOUTS.DEBOUNCE);
      }
      errorMsg.textContent = 'Please fill in all required fields before paying';
      errorMsg.style.display = 'block';
      errorMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
      customBtn.style.opacity = '1';
      return;
    }

    // Show loading state
    customBtn.disabled = true;
    const originalText = 'PAY WITH PAYPAL';
    customBtn.innerHTML = '<span>Processing...</span>';

    const orderData = {
      customer: {
        email: (form as any).email.value,
        firstName: (form as any).firstName.value,
        lastName: (form as any).lastName.value,
        phone: (form as any).phone?.value || '',
        userId: state.currentUser?.uid || null
      },
      shipping: hasPhysicalItems ? {
        address1: (form as any).address1.value,
        address2: (form as any).address2?.value || '',
        city: (form as any).city.value,
        county: (form as any).county?.value || '',
        postcode: (form as any).postcode.value,
        country: (form as any).country.value
      } : null,
      items: state.cart.map((item: any) => ({
        id: item.id || item.productId,
        productId: item.productId || item.id,
        releaseId: item.releaseId || item.productId || item.id,
        trackId: item.trackId || null,
        name: item.name,
        type: item.type || item.productType,
        price: item.price,
        quantity: item.quantity,
        image: item.image || item.artwork,
        size: item.size || null,
        color: (item.color && typeof item.color === 'object') ? item.color.name : (item.color || null)
      })),
      totals: { subtotal, shipping, freshWaxFee, stripeFee, serviceFees, total },
      hasPhysicalItems,
      appliedCredit: state.appliedCredit || 0,
      returnUrl: window.location.origin + '/api/paypal/capture-redirect/'
    };

    // Create PayPal order with timeout protection
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.LONG);

    let response;
    try {
      response = await fetch('/api/paypal/create-order/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderData),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
    } catch (fetchErr: unknown) {
      clearTimeout(timeoutId);
      if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
        throw new Error('Request timed out. Please check your connection and try again.');
      }
      throw new Error('Network error. Please check your connection and try again.');
    }

    if (!response.ok) {
      const result = await response.json();
      // Check for specific error types
      if (result.unavailableItems && result.unavailableItems.length > 0) {
        const itemNames = result.unavailableItems.map((item: any) => item.name).join(', ');
        throw new Error(`Some items are no longer available: ${itemNames}. Please update your cart and try again.`);
      }
      throw new Error(result.error || 'Failed to create PayPal order');
    }

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.error || 'Failed to create PayPal order');
    }

    // Store order data for capture
    try { localStorage.setItem('pendingPayPalOrder', JSON.stringify(orderData)); } catch (e: unknown){ /* intentional: localStorage may be full or unavailable in Safari private browsing */ }

    // Redirect to PayPal approval URL
    if (result.approvalUrl) {
      window.location.href = result.approvalUrl;
    } else {
      throw new Error('No PayPal approval URL returned');
    }

  } catch (error: unknown) {
    state.logger.error('PayPal error:', error);
    errorMsg.textContent = (error instanceof Error ? error.message : null) || 'PayPal error. Please try again.';
    errorMsg.style.display = 'block';
    errorMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Reset button - restore original state
    customBtn.disabled = false;
    customBtn.style.opacity = '1';
    customBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="pointer-events: none;">
      <path d="M7.076 21.337H2.47a.641.641 0 0 1-.633-.74L4.944 3.217a.774.774 0 0 1 .763-.645h6.333c2.097 0 3.768.514 4.967 1.53 1.178 1.001 1.763 2.442 1.737 4.28-.023 1.596-.492 2.95-1.392 4.02-.888 1.054-2.118 1.808-3.654 2.24a15.42 15.42 0 0 1-4.108.52H7.7l-.625 6.175z" fill="#003087"/>
      <path d="M23.048 7.667c-.03 1.651-.523 3.033-1.463 4.108-.953 1.088-2.256 1.86-3.87 2.293-1.157.31-2.47.466-3.896.466h-1.76a.774.774 0 0 0-.764.645l-1.14 7.218a.641.641 0 0 1-.633.54H6.5l-.09.528a.641.641 0 0 0 .634.74h4.022a.774.774 0 0 0 .763-.645l.704-4.46.045-.232a.774.774 0 0 1 .764-.645h.481c3.114 0 5.553-1.265 6.266-4.925.298-1.53.143-2.807-.658-3.704a3.198 3.198 0 0 0-.383-.327z" fill="#0070E0"/>
      <path d="M21.754 7.151a7.12 7.12 0 0 0-.877-.19 11.24 11.24 0 0 0-1.79-.133h-5.276a.752.752 0 0 0-.741.632l-1.12 7.1-.032.207a.774.774 0 0 1 .764-.645h1.59c3.127 0 5.574-1.27 6.29-4.944.021-.109.04-.215.055-.318.213-1.143.001-1.921-.863-2.71z" fill="#003087"/>
    </svg> <span style="pointer-events: none;">PAY WITH PAYPAL</span>`;
  }
}

export function renderPayPalButtons(state: CheckoutState) {
  if (state.paypalButtonsRendered || !(window as any).paypal) return;

  const container = document.getElementById('paypal-button-container');
  if (!container) return;

  // Set flag immediately to prevent double rendering
  state.paypalButtonsRendered = true;
  container.innerHTML = '';

  (window as any).paypal.Buttons({
    style: {
      layout: 'vertical',
      color: 'gold',
      shape: 'rect',
      label: 'paypal',
      height: 55,
      tagline: false
    },

    createOrder: async function(data: any, actions: any) {
      // Skip email verification on checkout
      const form = document.getElementById('checkoutForm') as HTMLFormElement;
      const { subtotal, shipping, hasPhysicalItems, freshWaxFee, stripeFee, serviceFees, total } = calculateTotals(state);

      // Validate form
      if (!form.checkValidity()) {
        form.reportValidity();
        throw new Error('Please fill in all required fields');
      }

      const orderData = {
        customer: {
          email: (form as any).email.value,
          firstName: (form as any).firstName.value,
          lastName: (form as any).lastName.value,
          phone: (form as any).phone?.value || '',
          userId: state.currentUser?.uid || null
        },
        shipping: hasPhysicalItems ? {
          address1: (form as any).address1.value,
          address2: (form as any).address2?.value || '',
          city: (form as any).city.value,
          county: (form as any).county?.value || '',
          postcode: (form as any).postcode.value,
          country: (form as any).country.value
        } : null,
        items: state.cart.map((item: any) => ({
          id: item.id || item.productId,
          productId: item.productId || item.id,
          releaseId: item.releaseId || item.productId || item.id,
          trackId: item.trackId || null,
          name: item.name,
          type: item.type || item.productType,
          price: item.price,
          quantity: item.quantity,
          image: item.image || item.artwork,
          size: item.size || null,
          color: (item.color && typeof item.color === 'object') ? item.color.name : (item.color || null)
        })),
        totals: { subtotal, shipping, freshWaxFee, stripeFee, serviceFees, total },
        hasPhysicalItems
      };

      // Create PayPal order with timeout protection
      const createController = new AbortController();
      const createTimeoutId = setTimeout(() => createController.abort(), TIMEOUTS.LONG);

      let response;
      try {
        response = await fetch('/api/paypal/create-order/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(orderData),
          signal: createController.signal
        });
        clearTimeout(createTimeoutId);
      } catch (fetchErr: unknown) {
        clearTimeout(createTimeoutId);
        if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
          throw new Error('Request timed out. Please try again.');
        }
        throw fetchErr;
      }

      if (!response.ok) {
        throw new Error('Failed to create PayPal order');
      }
      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error || 'Failed to create PayPal order');
      }

      // Store order data for capture
      (window as any).pendingPayPalOrderData = orderData;

      return result.orderId;
    },

    onApprove: async function(data: any, actions: any) {
      const errorMsg = document.getElementById('error-message')!;
      errorMsg.style.display = 'none';

      try {
        // Get idToken if logged in
        let idToken = null;
        if (state.currentUser) {
          try {
            idToken = await state.currentUser.getIdToken();
          } catch (e: unknown){
            // Token retrieval failed — continue without auth
          }
        }

        // Capture the payment with timeout protection
        const captureController = new AbortController();
        const captureTimeoutId = setTimeout(() => captureController.abort(), TIMEOUTS.LONG);

        let response;
        try {
          response = await fetch('/api/paypal/capture-order/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              paypalOrderId: data.orderID,
              orderData: (window as any).pendingPayPalOrderData,
              idToken
            }),
            signal: captureController.signal
          });
          clearTimeout(captureTimeoutId);
        } catch (fetchErr: unknown) {
          clearTimeout(captureTimeoutId);
          if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
            throw new Error('Payment capture timed out. Please check your order status.');
          }
          throw fetchErr;
        }

        if (!response.ok) {
          throw new Error('Payment capture failed');
        }
        const result = await response.json();

        if (result.success) {
          // Clear cart
          try {
            const customerId = getCustomerIdFromCookie();
            if (customerId) {
              localStorage.removeItem('freshwax_cart_' + customerId);
            }
            localStorage.removeItem('cart');
          } catch (e: unknown){ /* intentional: localStorage may throw in private browsing — cart clear is best-effort */ }
          window.dispatchEvent(new CustomEvent('cartUpdated', { detail: { items: [] } }));

          // Redirect to confirmation
          window.location.href = `/order-confirmation/${result.orderId}/`;
        } else {
          throw new Error(result.error || 'Payment failed');
        }
      } catch (error: unknown) {
        state.logger.error('PayPal capture error:', error);
        errorMsg.textContent = (error instanceof Error ? error.message : null) || 'Payment failed. Please try again.';
        errorMsg.style.display = 'block';
      }
    },

    onError: function(err: unknown) {
      state.logger.error('PayPal error:', err);
      const errorMsg = document.getElementById('error-message')!;
      errorMsg.textContent = 'PayPal error. Please try again or use card payment.';
      errorMsg.style.display = 'block';
    },

    onCancel: function() {
      // PayPal payment cancelled by user
    }
  }).render('#paypal-button-container').then(() => {
    // Force full width on all PayPal elements after render
    setTimeout(() => {
      const container = document.getElementById('paypal-button-container');
      if (container) {
        const allDivs = container.querySelectorAll('div');
        allDivs.forEach((div: HTMLDivElement) => {
          div.style.width = '100%';
          div.style.maxWidth = '100%';
        });
        const iframes = container.querySelectorAll('iframe');
        iframes.forEach((iframe: HTMLIFrameElement) => {
          iframe.style.width = '100%';
          iframe.style.maxWidth = '100%';
        });
      }
    }, 100);
  }).catch((err: unknown) => {
    state.logger.error('PayPal render error:', err);
    // Reset flag on error so user can retry
    state.paypalButtonsRendered = false;
  });
}

/**
 * Setup bfcache pageshow handler for button reset
 */
export function setupPageShowHandler(state: CheckoutState) {
  window.addEventListener('pageshow', function(event) {
    if (event.persisted) {
      const submitBtn = document.getElementById('submitBtn') as HTMLButtonElement;
      const customPaypalBtn = document.getElementById('customPaypalBtn') as HTMLButtonElement;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.style.background = '#dc2626';
        submitBtn.style.color = '#fff';
        const { total } = calculateTotals(state);
        const finalTotal = Math.max(0, total - (state.appliedCredit || 0));
        if (finalTotal === 0) {
          submitBtn.textContent = 'COMPLETE FREE ORDER';
          submitBtn.style.background = '#16a34a';
        } else {
          submitBtn.textContent = 'PAY WITH CARD \u2014 \u00a3' + finalTotal.toFixed(2);
        }
      }
      if (customPaypalBtn) {
        customPaypalBtn.disabled = false;
        customPaypalBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7.076 21.337H2.47a.641.641 0 0 1-.633-.74L4.944 3.217a.774.774 0 0 1 .763-.645h6.333c2.097 0 3.768.514 4.967 1.53 1.178 1.001 1.763 2.442 1.737 4.28-.023 1.596-.492 2.95-1.392 4.02-.888 1.054-2.118 1.808-3.654 2.24a15.42 15.42 0 0 1-4.108.52H7.7l-.625 6.175z" fill="#003087"/><path d="M23.048 7.667c-.03 1.651-.523 3.033-1.463 4.108-.953 1.088-2.256 1.86-3.87 2.293-1.157.31-2.47.466-3.896.466h-1.76a.774.774 0 0 0-.764.645l-1.14 7.218a.641.641 0 0 1-.633.54H6.5l-.09.528a.641.641 0 0 0 .634.74h4.022a.774.774 0 0 0 .763-.645l.704-4.46.045-.232a.774.774 0 0 1 .764-.645h.481c3.114 0 5.553-1.265 6.266-4.925.298-1.53.143-2.807-.658-3.704a3.198 3.198 0 0 0-.383-.327z" fill="#0070E0"/><path d="M21.754 7.151a7.12 7.12 0 0 0-.877-.19 11.24 11.24 0 0 0-1.79-.133h-5.276a.752.752 0 0 0-.741.632l-1.12 7.1-.032.207a.774.774 0 0 1 .764-.645h1.59c3.127 0 5.574-1.27 6.29-4.944.021-.109.04-.215.055-.318.213-1.143.001-1.921-.863-2.71z" fill="#003087"/></svg> PAY WITH PAYPAL';
      }
      // Hide any stale error messages
      const errorMsg = document.getElementById('error-message');
      if (errorMsg) errorMsg.style.display = 'none';
    }
  });
}

/**
 * Setup document-level click delegation for PayPal button.
 * More reliable on mobile than attaching handlers to dynamically-created buttons.
 */
export function setupPayPalClickDelegation(state: CheckoutState) {
  document.addEventListener('click', function(e) {
    const target = (e.target as HTMLElement).closest('#customPaypalBtn');
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    handleCustomPayPalClick(state);
  });
}
