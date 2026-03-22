/**
 * Checkout Stripe — Stripe checkout session creation and form submission.
 */
import { createClientLogger } from '../client-logger';
import type { CheckoutState } from './state';
import { calculateTotals, getCustomerIdFromCookie, getFormFieldValue, getFormFieldChecked } from './validation';

const logger = createClientLogger('Checkout');

export async function handleStripeSubmit(state: CheckoutState, form: HTMLFormElement, isFreeOrder: boolean) {
  const { subtotal, shipping, hasPhysicalItems, freshWaxFee, stripeFee, serviceFees, total } = calculateTotals(state.cart);
  const submitBtn = document.getElementById('submitBtn') as HTMLButtonElement;
  const errorMsg = document.getElementById('error-message') as HTMLElement;

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

  // Save details to customer account if checkbox is checked
  const saveDetails = getFormFieldChecked(form, 'saveDetails');
  if (saveDetails && state.currentUser) {
    try {
      const saveToken = await state.currentUser.getIdToken();
      await fetch('/api/checkout-data/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${saveToken}`
        },
        body: JSON.stringify({
          firstName: getFormFieldValue(form, 'firstName'),
          lastName: getFormFieldValue(form, 'lastName'),
          email: getFormFieldValue(form, 'email'),
          phone: getFormFieldValue(form, 'phone'),
          address1: getFormFieldValue(form, 'address1'),
          address2: getFormFieldValue(form, 'address2'),
          city: getFormFieldValue(form, 'city'),
          county: getFormFieldValue(form, 'county'),
          postcode: getFormFieldValue(form, 'postcode'),
          country: getFormFieldValue(form, 'country') || 'United Kingdom'
        })
      });
    } catch (e: unknown) {
      logger.error('Error saving customer details:', e);
    }
  }

  // Track begin checkout event
  window.trackBeginCheckout?.(state.cart, total);

  const orderData: Record<string, unknown> = {
    customer: {
      email: getFormFieldValue(form, 'email'),
      firstName: getFormFieldValue(form, 'firstName'),
      lastName: getFormFieldValue(form, 'lastName'),
      phone: getFormFieldValue(form, 'phone'),
      userId: state.currentUser?.uid || null
    },
    shipping: hasPhysicalItems ? {
      address1: getFormFieldValue(form, 'address1'),
      address2: getFormFieldValue(form, 'address2'),
      city: getFormFieldValue(form, 'city'),
      county: getFormFieldValue(form, 'county'),
      postcode: getFormFieldValue(form, 'postcode'),
      country: getFormFieldValue(form, 'country')
    } : null,
    items: state.cart.filter((item) => item && item.name).map((item) => ({
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
        const tokenPromise = state.currentUser.getIdToken();
        const timeoutPromise = new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('Token timeout')), 5000)
        );
        orderData.idToken = await Promise.race([tokenPromise, timeoutPromise]);
      } catch (tokenErr: unknown) {
        // Token retrieval failed - API will handle unauthenticated request
      }
    }

    if (isFreeOrder) {
      // Handle free order
      const freeOrderHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (orderData.idToken) {
        freeOrderHeaders['Authorization'] = `Bearer ${orderData.idToken}`;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      let response: Response;
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
        try {
          const customerId = getCustomerIdFromCookie();
          if (customerId) {
            localStorage.removeItem('freshwax_cart_' + customerId);
          }
        } catch (e: unknown) { /* intentional: localStorage may throw in private browsing */ }

        window.location.href = '/checkout/success/?orderId=' + result.orderId;
      } else {
        throw new Error(result.error || 'Failed to complete free order');
      }
    } else {
      // Create Stripe checkout session
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      let response: Response;
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
        if (result.unavailableItems && result.unavailableItems.length > 0) {
          const itemNames = result.unavailableItems.map((item: UnavailableItem) => item.name).join(', ');
          throw new Error(`Some items are no longer available: ${itemNames}. Please update your cart and try again.`);
        }
        throw new Error(result.error || 'Server error. Please try again.');
      }

      const result = await response.json();

      if (result.success && result.checkoutUrl) {
        window.location.href = result.checkoutUrl;
      } else {
        throw new Error(result.error || 'Failed to create checkout session');
      }
    }
  } catch (error: unknown) {
    logger.error('Checkout error:', error);
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
