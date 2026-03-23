import { test, expect } from '@playwright/test';

/**
 * CI Smoke Tests — lightweight checks run against staging after deployment.
 * These must pass before production deployment proceeds.
 *
 * Designed to be fast: uses domcontentloaded (not networkidle), minimal waits.
 */

// ─────────────────────────────────────────────────────────
// 1. Critical pages load with HTTP 200
// ─────────────────────────────────────────────────────────

test.describe('Critical pages return 200', () => {
  const pages = [
    { path: '/', name: 'Homepage' },
    { path: '/releases/', name: 'Releases' },
    { path: '/dj-mixes/', name: 'DJ Mixes' },
    { path: '/merch/', name: 'Merch' },
    { path: '/crates/', name: 'Crates' },
    { path: '/live/', name: 'Live' },
    { path: '/cart/', name: 'Cart' },
    { path: '/login/', name: 'Login' },
    { path: '/contact/', name: 'Contact' },
  ];

  for (const p of pages) {
    test(`${p.name} (${p.path}) returns 200`, async ({ page }) => {
      const response = await page.goto(p.path, { waitUntil: 'domcontentloaded' });
      expect(response?.status()).toBe(200);
      const title = await page.title();
      expect(title.length).toBeGreaterThan(0);
    });
  }
});

// ─────────────────────────────────────────────────────────
// 2. Key pages render meaningful content
// ─────────────────────────────────────────────────────────

test.describe('Key pages render content', () => {
  test('Homepage renders hero section', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const h1 = page.locator('h1');
    await expect(h1).toBeVisible();
    const text = await h1.textContent();
    expect(text).toContain('FRESH');
  });

  test('Releases page has heading and content', async ({ page }) => {
    await page.goto('/releases/', { waitUntil: 'domcontentloaded' });
    const h1 = page.locator('h1');
    await expect(h1).toBeVisible();
    const bodyText = await page.textContent('body');
    expect(bodyText!.length).toBeGreaterThan(200);
  });

  test('DJ Mixes page has content', async ({ page }) => {
    await page.goto('/dj-mixes/', { waitUntil: 'domcontentloaded' });
    const bodyText = await page.textContent('body');
    expect(bodyText!.length).toBeGreaterThan(200);
  });
});

// ─────────────────────────────────────────────────────────
// 3. API health check
// ─────────────────────────────────────────────────────────

test.describe('API health', () => {
  test('/api/health/public/ returns 200 with success', async ({ request }) => {
    const response = await request.get('/api/health/public/');
    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data.status).toBe('ok');
  });

  test('Search API responds', async ({ request }) => {
    const response = await request.get('/api/search-releases/?q=jungle&limit=1');
    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────
// 4. Security headers
// ─────────────────────────────────────────────────────────

test.describe('Security headers present', () => {
  test('Homepage has security headers', async ({ request }) => {
    const response = await request.get('/');
    const headers = response.headers();
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['strict-transport-security']).toContain('max-age=');
    expect(headers['content-security-policy']).toBeTruthy();
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });
});

// ─────────────────────────────────────────────────────────
// 5. SEO essentials
// ─────────────────────────────────────────────────────────

test.describe('SEO essentials', () => {
  test('robots.txt exists and references sitemap', async ({ request }) => {
    const response = await request.get('/robots.txt');
    expect(response.status()).toBe(200);
    const text = await response.text();
    expect(text).toContain('Sitemap');
  });

  test('sitemap.xml returns valid XML', async ({ request }) => {
    const response = await request.get('/sitemap.xml/');
    expect(response.status()).toBe(200);
    const text = await response.text();
    expect(text).toContain('<?xml');
    expect(text).toContain('<urlset');
  });

  test('Homepage has OG meta tags', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const ogTitle = await page.getAttribute('meta[property="og:title"]', 'content');
    expect(ogTitle).toBeTruthy();
    const ogImage = await page.getAttribute('meta[property="og:image"]', 'content');
    expect(ogImage).toBeTruthy();
    const metaDesc = await page.getAttribute('meta[name="description"]', 'content');
    expect(metaDesc).toBeTruthy();
    expect(metaDesc!.length).toBeGreaterThan(20);
  });
});

// ─────────────────────────────────────────────────────────
// 6. No critical JS errors on key pages
// ─────────────────────────────────────────────────────────

test.describe('No critical JS errors', () => {
  const criticalPages = ['/', '/releases/', '/dj-mixes/', '/live/'];

  for (const path of criticalPages) {
    test(`${path} has no critical JS errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(err.message));
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      // Wait briefly for any deferred scripts
      await page.waitForTimeout(2000);
      const critical = errors.filter(
        (e) =>
          !e.includes('Script error') &&
          !e.includes('ResizeObserver') &&
          !e.includes('gtag') &&
          !e.includes('analytics') &&
          !e.includes('google') &&
          !e.includes('Pusher') &&
          !e.includes('websocket') &&
          !e.includes('net::ERR')
      );
      expect(critical).toEqual([]);
    });
  }
});

// ─────────────────────────────────────────────────────────
// 7. Trailing slash redirects (Cloudflare middleware)
// ─────────────────────────────────────────────────────────

test.describe('Trailing slash redirects', () => {
  test('/releases redirects to /releases/', async ({ request }) => {
    const response = await request.get('/releases', { maxRedirects: 0 });
    expect([301, 308]).toContain(response.status());
    expect(response.headers()['location']).toContain('/releases/');
  });
});
