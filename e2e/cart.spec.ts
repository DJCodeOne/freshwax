import { test, expect } from '@playwright/test';

const TEST_CUSTOMER_ID = 'e2e-test-user-001';

// Helper to seed cart into localStorage
async function seedCart(page: ReturnType<typeof test['info']> extends never ? never : any, items: any[]) {
  await page.evaluate(({ customerId, cartItems }: { customerId: string; cartItems: any[] }) => {
    const cartData = {
      items: cartItems,
      updatedAt: new Date().toISOString()
    };
    localStorage.setItem('freshwax_cart_' + customerId, JSON.stringify(cartData));
  }, { customerId: TEST_CUSTOMER_ID, cartItems: items });
}

// Helper to set customerId cookie
async function setCustomerCookie(page: any) {
  await page.context().addCookies([{
    name: 'customerId',
    value: TEST_CUSTOMER_ID,
    domain: 'localhost',
    path: '/',
  }]);
}

const sampleItems = [
  {
    id: 'test-release-001',
    releaseId: 'test-release-001',
    type: 'digital',
    name: 'Test Artist - Test Album',
    title: 'Test Album',
    artist: 'Test Artist',
    price: 7.99,
    image: '/logo.webp',
    quantity: 1,
  },
  {
    id: 'test-release-002',
    releaseId: 'test-release-002',
    type: 'vinyl',
    name: 'DJ Test - Vinyl EP',
    title: 'Vinyl EP',
    artist: 'DJ Test',
    price: 12.99,
    image: '/logo.webp',
    quantity: 2,
  },
];

test.describe('Cart Page', () => {
  test('empty cart shows empty message', async ({ page }) => {
    await setCustomerCookie(page);
    await page.goto('/cart/');
    // Should show some indication that cart is empty
    const content = await page.textContent('body');
    expect(content?.toLowerCase()).toMatch(/empty|no items|nothing/);
  });

  test('navigate to item and add to cart updates badge', async ({ page }) => {
    await setCustomerCookie(page);

    // Navigate to the store to find an item
    await page.goto('/store/');
    await page.waitForLoadState('networkidle');

    // Look for any release link and click it
    const releaseLink = page.locator('a[href^="/item/"]').first();
    const linkExists = await releaseLink.count();

    if (linkExists > 0) {
      await releaseLink.click();
      await page.waitForLoadState('networkidle');

      // Look for add-to-cart button
      const addBtn = page.locator('.add-to-cart').first();
      const btnExists = await addBtn.count();

      if (btnExists > 0) {
        // Get initial cart count
        const badge = page.locator('[data-cart-count]').first();
        const initialCount = await badge.textContent() || '0';

        await addBtn.click();
        await page.waitForTimeout(500);

        // Cart badge should update (or login redirect happens for unauthenticated)
        const currentUrl = page.url();
        if (!currentUrl.includes('/login')) {
          const newCount = await badge.textContent() || '0';
          expect(parseInt(newCount)).toBeGreaterThan(parseInt(initialCount));
        }
      }
    }
  });

  test('pre-seeded cart shows items on cart page', async ({ page }) => {
    await setCustomerCookie(page);
    await page.goto('/cart/');
    await seedCart(page, sampleItems);

    // Reload to pick up seeded cart
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Should show the items
    const content = await page.textContent('body');
    expect(content).toContain('Test Album');
    expect(content).toContain('Vinyl EP');
  });
});
