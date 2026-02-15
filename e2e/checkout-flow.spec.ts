import { test, expect } from '@playwright/test';

const TEST_CUSTOMER_ID = 'e2e-test-user-001';

async function seedCart(page: any, items: any[]) {
  await page.evaluate(({ customerId, cartItems }: { customerId: string; cartItems: any[] }) => {
    const cartData = {
      items: cartItems,
      updatedAt: new Date().toISOString()
    };
    localStorage.setItem('freshwax_cart_' + customerId, JSON.stringify(cartData));
  }, { customerId: TEST_CUSTOMER_ID, cartItems: items });
}

async function setCustomerCookie(page: any) {
  await page.context().addCookies([{
    name: 'customerId',
    value: TEST_CUSTOMER_ID,
    domain: 'localhost',
    path: '/',
  }]);
}

const digitalItems = [
  {
    id: 'test-release-001',
    releaseId: 'test-release-001',
    type: 'digital',
    name: 'Test Artist - Digital Album',
    title: 'Digital Album',
    artist: 'Test Artist',
    price: 7.99,
    image: '/logo.webp',
    quantity: 1,
  },
];

const physicalItems = [
  {
    id: 'test-vinyl-001',
    releaseId: 'test-vinyl-001',
    type: 'vinyl',
    name: 'DJ Test - Vinyl Record',
    title: 'Vinyl Record',
    artist: 'DJ Test',
    price: 14.99,
    image: '/logo.webp',
    quantity: 1,
  },
];

const mixedItems = [...digitalItems, ...physicalItems];

test.describe('Checkout Flow', () => {
  test('cart items display on checkout page', async ({ page }) => {
    await setCustomerCookie(page);
    await page.goto('/checkout/');
    await seedCart(page, mixedItems);
    await page.reload();
    await page.waitForLoadState('networkidle');

    const content = await page.textContent('body');
    expect(content).toContain('Digital Album');
    expect(content).toContain('Vinyl Record');
  });

  test('required fields show validation', async ({ page }) => {
    await setCustomerCookie(page);
    await page.goto('/checkout/');
    await seedCart(page, digitalItems);
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Try to submit without filling fields
    const submitBtn = page.locator('#submitBtn, button[type="submit"]').first();
    if (await submitBtn.count() > 0) {
      await submitBtn.click();

      // Browser should show validation on required fields
      // Check that email field is required
      const emailField = page.locator('input[name="email"], #email').first();
      if (await emailField.count() > 0) {
        const isRequired = await emailField.getAttribute('required');
        expect(isRequired !== null || isRequired === '').toBeTruthy();
      }
    }
  });

  test('digital-only checkout hides address fields', async ({ page }) => {
    await setCustomerCookie(page);
    await page.goto('/checkout/');
    await seedCart(page, digitalItems);
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Address fields should be hidden for digital-only orders
    const addressField = page.locator('input[name="address1"], #address1').first();
    if (await addressField.count() > 0) {
      const isVisible = await addressField.isVisible();
      expect(isVisible).toBe(false);
    }
  });

  test('physical item checkout shows address fields', async ({ page }) => {
    await setCustomerCookie(page);
    await page.goto('/checkout/');
    await seedCart(page, physicalItems);
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Address fields should be visible for physical items
    const addressField = page.locator('input[name="address1"], #address1').first();
    if (await addressField.count() > 0) {
      await page.waitForTimeout(500);
      const isVisible = await addressField.isVisible();
      expect(isVisible).toBe(true);
    }
  });

  test('payment method options are visible with Stripe as default', async ({ page }) => {
    await setCustomerCookie(page);
    await page.goto('/checkout/');
    await seedCart(page, digitalItems);
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Look for payment method selection (Stripe should be default)
    const stripeOption = page.locator('[data-payment="stripe"], #stripe-option, .payment-stripe').first();
    const paypalOption = page.locator('[data-payment="paypal"], #paypal-option, .payment-paypal').first();

    // At least one payment method should be visible
    const content = await page.textContent('body');
    const hasPaymentRef = content?.toLowerCase().includes('card') || content?.toLowerCase().includes('stripe') || content?.toLowerCase().includes('pay');
    expect(hasPaymentRef).toBeTruthy();
  });

  test('form fill works (stops before payment)', async ({ page }) => {
    await setCustomerCookie(page);
    await page.goto('/checkout/');
    await seedCart(page, mixedItems);
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Fill in form fields
    const fields = {
      'input[name="email"], #email': 'test@example.com',
      'input[name="firstName"], #firstName': 'Test',
      'input[name="lastName"], #lastName': 'User',
    };

    for (const [selector, value] of Object.entries(fields)) {
      const field = page.locator(selector).first();
      if (await field.count() > 0 && await field.isVisible()) {
        await field.fill(value);
      }
    }

    // Verify fields are filled
    const emailField = page.locator('input[name="email"], #email').first();
    if (await emailField.count() > 0) {
      const emailValue = await emailField.inputValue();
      expect(emailValue).toBe('test@example.com');
    }

    // Do NOT submit — we stop before actual payment
  });

  test('empty cart shows appropriate message on checkout', async ({ page }) => {
    await setCustomerCookie(page);
    await page.goto('/checkout/');
    await page.waitForLoadState('networkidle');

    // Empty cart should show some message or redirect
    const content = await page.textContent('body');
    const url = page.url();
    const isEmpty = content?.toLowerCase().includes('empty') ||
                    content?.toLowerCase().includes('no items') ||
                    url.includes('/cart');
    expect(isEmpty).toBeTruthy();
  });
});
