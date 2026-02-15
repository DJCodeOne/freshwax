import { test, expect } from '@playwright/test';

// Production smoke tests — run against live freshwax.co.uk
// Usage: npx playwright test e2e/production-smoke.spec.ts --config=playwright.production.config.ts

test.describe('Page Loading', () => {
  const pages = [
    { path: '/', name: 'Home' },
    { path: '/releases/', name: 'Releases' },
    { path: '/dj-mixes/', name: 'DJ Mixes' },
    { path: '/merch/', name: 'Merch' },
    { path: '/crates/', name: 'Crates' },
    { path: '/live/', name: 'Live' },
    { path: '/schedule/', name: 'Schedule' },
    { path: '/giftcards/', name: 'Gift Cards' },
    { path: '/contact/', name: 'Contact' },
    { path: '/login/', name: 'Login' },
    { path: '/register/', name: 'Register' },
    { path: '/cart/', name: 'Cart' },
    { path: '/checkout/', name: 'Checkout' },
    { path: '/privacy/', name: 'Privacy' },
    { path: '/terms/', name: 'Terms' },
  ];

  for (const p of pages) {
    test(`${p.name} page loads (${p.path})`, async ({ page }) => {
      const response = await page.goto(p.path, { waitUntil: 'domcontentloaded' });
      expect(response?.status()).toBe(200);
      // Page should have a title
      const title = await page.title();
      expect(title.length).toBeGreaterThan(0);
    });
  }
});

test.describe('Console Errors', () => {
  test('home page has no critical JS errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/', { waitUntil: 'networkidle' });
    // Filter out known third-party errors
    const criticalErrors = errors.filter(e =>
      !e.includes('Script error') &&
      !e.includes('ResizeObserver') &&
      !e.includes('gtag') &&
      !e.includes('analytics') &&
      !e.includes('google')
    );
    expect(criticalErrors).toEqual([]);
  });

  test('releases page has no critical JS errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/releases/', { waitUntil: 'networkidle' });
    const criticalErrors = errors.filter(e =>
      !e.includes('Script error') &&
      !e.includes('ResizeObserver') &&
      !e.includes('gtag') &&
      !e.includes('analytics') &&
      !e.includes('google')
    );
    expect(criticalErrors).toEqual([]);
  });

  test('dj-mixes page has no critical JS errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/dj-mixes/', { waitUntil: 'networkidle' });
    const criticalErrors = errors.filter(e =>
      !e.includes('Script error') &&
      !e.includes('ResizeObserver') &&
      !e.includes('gtag') &&
      !e.includes('analytics') &&
      !e.includes('google')
    );
    expect(criticalErrors).toEqual([]);
  });

  test('live page has no critical JS errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/live/', { waitUntil: 'networkidle' });
    const criticalErrors = errors.filter(e =>
      !e.includes('Script error') &&
      !e.includes('ResizeObserver') &&
      !e.includes('gtag') &&
      !e.includes('analytics') &&
      !e.includes('google')
    );
    expect(criticalErrors).toEqual([]);
  });

  test('checkout page has no critical JS errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/checkout/', { waitUntil: 'networkidle' });
    const criticalErrors = errors.filter(e =>
      !e.includes('Script error') &&
      !e.includes('ResizeObserver') &&
      !e.includes('gtag') &&
      !e.includes('analytics') &&
      !e.includes('google')
    );
    expect(criticalErrors).toEqual([]);
  });
});

test.describe('Header and Navigation', () => {
  test('header renders with logo and nav links', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Logo should be visible (desktop layout)
    const logo = page.locator('#logoDesktop img.fwx-logo-desktop');
    await expect(logo).toBeVisible();

    // Desktop nav should be visible
    const nav = page.locator('nav.fwx-nav');
    await expect(nav).toBeVisible();
  });

  test('mobile menu toggle works', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Look for mobile menu button
    const menuBtn = page.locator('[aria-label*="menu" i], .mobile-menu-btn, #mobileMenuBtn, button.hamburger').first();
    if (await menuBtn.count() > 0) {
      await menuBtn.click();
      await page.waitForTimeout(500);
      // Some menu content should now be visible
      const menuContent = page.locator('[role="menu"], .mobile-menu, .mobile-nav, nav.open').first();
      if (await menuContent.count() > 0) {
        await expect(menuContent).toBeVisible();
      }
    }
  });

  test('navigation between pages works', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Click on Releases link in the desktop nav bar
    const releasesLink = page.locator('a.fwx-nav-btn[href="/releases/"]');
    await expect(releasesLink).toBeVisible();
    await releasesLink.click();
    await page.waitForURL('**/releases/**');
    expect(page.url()).toContain('/releases/');
  });
});

test.describe('Key Content Renders', () => {
  test('releases page shows release items', async ({ page }) => {
    await page.goto('/releases/', { waitUntil: 'networkidle' });
    // Should have at least some content (release cards, images, etc.)
    const items = page.locator('[class*="release"], [class*="plate"], article, .card').first();
    // Wait a bit for dynamic content
    await page.waitForTimeout(2000);
    const bodyText = await page.textContent('body');
    // Page should have substantial content (not just a header)
    expect(bodyText!.length).toBeGreaterThan(200);
  });

  test('dj-mixes page shows mix items', async ({ page }) => {
    await page.goto('/dj-mixes/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const bodyText = await page.textContent('body');
    expect(bodyText!.length).toBeGreaterThan(200);
  });

  test('merch page loads content', async ({ page }) => {
    await page.goto('/merch/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const bodyText = await page.textContent('body');
    expect(bodyText!.length).toBeGreaterThan(200);
  });

  test('crates page loads content', async ({ page }) => {
    await page.goto('/crates/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const bodyText = await page.textContent('body');
    expect(bodyText!.length).toBeGreaterThan(200);
  });
});

test.describe('API Endpoints', () => {
  test('search API returns results', async ({ request }) => {
    const response = await request.get('/api/search-releases/?q=jungle&limit=5');
    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });

  test('cart API requires auth', async ({ request }) => {
    const response = await request.get('/api/cart/');
    expect(response.status()).toBe(401);
  });

  test('contact API validates input', async ({ request }) => {
    const response = await request.post('/api/contact/', {
      data: {},
      headers: { 'Content-Type': 'application/json' }
    });
    expect(response.status()).toBe(400);
  });

  test('admin endpoints require auth', async ({ request }) => {
    const response = await request.get('/api/admin/errors/');
    expect([401, 403]).toContain(response.status());
  });

  test('sitemap returns XML', async ({ request }) => {
    const response = await request.get('/sitemap.xml/');
    expect(response.status()).toBe(200);
    const text = await response.text();
    expect(text).toContain('<?xml');
    expect(text).toContain('<urlset');
  });
});

test.describe('Security Headers', () => {
  test('response includes security headers', async ({ request }) => {
    const response = await request.get('/');
    const headers = response.headers();
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['strict-transport-security']).toContain('max-age=');
    expect(headers['content-security-policy']).toContain("default-src 'self'");
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  test('API responses include security headers', async ({ request }) => {
    const response = await request.get('/api/search-releases/?q=test');
    const headers = response.headers();
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
  });
});

test.describe('Trailing Slash Redirects', () => {
  test('paths without trailing slash redirect', async ({ request }) => {
    const response = await request.get('/releases', { maxRedirects: 0 });
    expect([301, 308]).toContain(response.status());
    expect(response.headers()['location']).toContain('/releases/');
  });

  // www redirect is handled at Cloudflare edge DNS level
  // and cannot be tested from local machines where www doesn't resolve
  test.skip('www redirects to non-www', async ({ request }) => {
    const response = await request.get('https://www.freshwax.co.uk/', { maxRedirects: 0 });
    expect(response.status()).toBe(301);
    expect(response.headers()['location']).toContain('freshwax.co.uk');
  });
});

test.describe('SEO Essentials', () => {
  test('home page has meta description and OG tags', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const metaDesc = await page.getAttribute('meta[name="description"]', 'content');
    expect(metaDesc).toBeTruthy();
    expect(metaDesc!.length).toBeGreaterThan(20);

    const ogTitle = await page.getAttribute('meta[property="og:title"]', 'content');
    expect(ogTitle).toBeTruthy();

    const ogImage = await page.getAttribute('meta[property="og:image"]', 'content');
    expect(ogImage).toBeTruthy();
  });

  test('robots.txt exists', async ({ request }) => {
    const response = await request.get('/robots.txt');
    expect(response.status()).toBe(200);
    const text = await response.text();
    expect(text).toContain('Sitemap');
  });
});

test.describe('Performance Basics', () => {
  test('home page loads under 5 seconds', async ({ page }) => {
    const start = Date.now();
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const loadTime = Date.now() - start;
    expect(loadTime).toBeLessThan(5000);
  });

  test('static assets have cache headers', async ({ request }) => {
    // Fetch the home page to find a hashed JS asset
    const pageResponse = await request.get('/');
    const html = await pageResponse.text();
    const jsMatch = html.match(/_astro\/[^"']+\.js/);
    if (jsMatch) {
      const assetResponse = await request.get('/' + jsMatch[0]);
      expect(assetResponse.status()).toBe(200);
      const cacheControl = assetResponse.headers()['cache-control'] || '';
      // Hashed assets should have long cache
      expect(cacheControl).toContain('max-age');
    }
  });
});
