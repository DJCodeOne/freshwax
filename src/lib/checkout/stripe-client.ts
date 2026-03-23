// src/lib/checkout/stripe-client.ts
// Stripe-specific logic: form submit handling, checkout session creation, free orders

import { TIMEOUTS } from '../timeouts';
import type { CheckoutState } from './types';
import { calculateTotals, getCustomerIdFromCookie } from './cart-validation';

/**
 * Handle checkout form submission — Stripe card payment or free order flow.
 * PayPal is handled separately by paypal-client.ts.
 */
export async function handleSubmit(
  e: Event,
  state: CheckoutState
) {
  e.preventDefault();
  const { subtotal, shipping, hasPhysicalItems, freshWaxFee, stripeFee, serviceFees, total } = calculateTotals(state);

  // Check if this is a free order (including when credit covers entire amount)
  const finalTotal = Math.max(0, total - state.appliedCredit);
  const isFreeOrder = finalTotal === 0;

  // If PayPal is selected and not a free order, don't process here
  // (PayPal is handled by document-level click delegation below)
  if (state.selectedPaymentMethod === 'paypal' && !isFreeOrder) {
    return;
  }

  const submitBtn = document.getElementById('submitBtn') as HTMLButtonElement;
  const errorMsg = document.getElementById('error-message')!;

  // Prevent double-submit
  if (submitBtn.disabled) return;

  submitBtn.disabled = true;
  submitBtn.style.background = '#333';
  submitBtn.style.color = '#999';
  errorMsg.style.display = 'none';

  if (isFreeOrder) {
    submitBtn.textContent = 'PROCESSING...';
  } else {
    submitBtn.textContent = 'REDIRECTING TO PAYMENT...';
  }

  const form = e.target as HTMLFormElement;

  // Save details to customer account if checkbox is checked
  const saveDetails = (form as any).saveDetails?.checked;
  if (saveDetails && state.currentUser) {
    try {
      const saveToken = await state.currentUser.getIdToken();
      const saveController = new AbortController();
      const saveTimeoutId = setTimeout(() => saveController.abort(), TIMEOUTS.API_EXTENDED);

      await fetch('/api/checkout-data/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${saveToken}`
        },
        body: JSON.stringify({
          firstName: form.firstName.value,
          lastName: form.lastName.value,
          email: form.email.value,
          phone: form.phone?.value || '',
          address1: form.address1?.value || '',
          address2: form.address2?.value || '',
          city: form.city?.value || '',
          county: form.county?.value || '',
          postcode: form.postcode?.value || '',
          country: form.country?.value || 'United Kingdom'
        }),
        signal: saveController.signal
      });
      clearTimeout(saveTimeoutId);
    } catch (e: unknown){
      state.logger.error('Error saving customer details:', e);
    }
  }

  // Track begin checkout event
  (window as any).trackBeginCheckout?.(state.cart, total);

  const orderData: any = {
    customer: {
      email: form.email.value,
      firstName: form.firstName.value,
      lastName: form.lastName.value,
      phone: form.phone?.value || '',
      userId: state.currentUser?.uid || null
    },
    shipping: hasPhysicalItems ? {
      address1: form.address1.value,
      address2: form.address2?.value || '',
      city: form.city.value,
      county: form.county?.value || '',
      postcode: form.postcode.value,
      country: form.country.value
    } : null,
    items: state.cart.filter((item: any) => item && item.name).map((item: any) => ({
      id: item.id || item.productId,
      productId: item.productId || item.id,
      releaseId: item.releaseId || item.productId || item.id,
      trackId: item.trackId || null,
      name: item.name || 'Item',
      type: item.type || item.productType || 'product',
      price: item.price || 0,
      quantity: item.quantity || 1,
      image: item.image || item.artwork || null,
      artwork: item.artwork || item.image || null,
      size: item.size || null,
      color: (item.color && typeof item.color === 'object') ? item.color.name : (item.color || null),
      artist: item.artist || null,
      title: item.title || null
    })),
    totals: { subtotal, shipping, freshWaxFee, stripeFee, serviceFees, total },
    hasPhysicalItems,
    appliedCredit: state.appliedCredit || 0
  };

  try {
    // Get Firebase ID token for authenticated write (with timeout)
    if (state.currentUser) {
      try {
        // Get Firebase ID token for auth
        const tokenPromise = state.currentUser.getIdToken();
        const timeoutPromise = new Promise((_: any, reject: any) =>
          setTimeout(() => reject(new Error('Token timeout')), TIMEOUTS.SHORT)
        );
        orderData.idToken = await Promise.race([tokenPromise, timeoutPromise]);
        // Got ID token successfully
      } catch (tokenErr: unknown) {
        // Token retrieval failed — API will handle unauthenticated request
      }
    }

    // Handle free orders (total = 0) differently
    if (isFreeOrder) {
      // Processing free order (credit covers total)

      const freeOrderHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (orderData.idToken) {
        freeOrderHeaders['Authorization'] = `Bearer ${orderData.idToken}`;
      }

      // Add timeout protection
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.LONG);

      let response;
      try {
        response = await fetch('/api/complete-free-order/', {
          method: 'POST',
          headers: freeOrderHeaders,
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
        throw new Error(result.error || 'Server error. Please try again.');
      }

      const result = await response.json();

      if (result.success && result.orderId) {
        // Free order completed successfully

        // Clear cart
        try {
          const customerId = getCustomerIdFromCookie();
          if (customerId) {
            localStorage.removeItem('freshwax_cart_' + customerId);
          }
        } catch (e: unknown){ /* intentional: localStorage may throw in private browsing — cart clear is best-effort */ }

        // Redirect to success page
        window.location.href = '/checkout/success/?orderId=' + result.orderId;
      } else {
        throw new Error(result.error || 'Failed to complete free order');
      }
    } else {
      // Create Stripe checkout session

      // Add timeout protection
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.LONG);

      let response;
      try {
        const stripeHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        if (orderData.idToken) {
          stripeHeaders['Authorization'] = `Bearer ${orderData.idToken}`;
        }
        response = await fetch('/api/stripe/create-checkout-session/', {
          method: 'POST',
          headers: stripeHeaders,
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
        throw new Error(result.error || 'Server error. Please try again.');
      }

      const result = await response.json();

      if (result.success && result.checkoutUrl) {
        // Redirect to Stripe checkout
        window.location.href = result.checkoutUrl;
      } else {
        throw new Error(result.error || 'Failed to create checkout session');
      }
    }
  } catch (error: unknown) {
    state.logger.error('Checkout error:', error);
    errorMsg.textContent = (error instanceof Error ? error.message : null) || 'Something went wrong. Please try again.';
    errorMsg.style.display = 'block';
    submitBtn.disabled = false;

    if (isFreeOrder) {
      submitBtn.textContent = 'COMPLETE FREE ORDER';
      submitBtn.style.background = '#16a34a';
    } else {
      submitBtn.textContent = `PAY WITH CARD \u2014 \u00a3${total.toFixed(2)}`;
      submitBtn.style.background = '#dc2626';
    }
    submitBtn.style.color = '#fff';
  }
}
