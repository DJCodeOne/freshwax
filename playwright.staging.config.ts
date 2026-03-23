import { defineConfig } from '@playwright/test';

/**
 * Staging Playwright config — used in CI after deploying to Cloudflare Pages
 * staging branch. Runs the lightweight CI smoke tests against the staging URL.
 *
 * Usage:
 *   STAGING_URL=https://staging.freshwax.pages.dev npx playwright test --config=playwright.staging.config.ts
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'ci-smoke.spec.ts',
  fullyParallel: true,
  retries: 2, // CI resilience — staging may have cold-start latency
  workers: 2,
  reporter: [['list'], ['github']],
  timeout: 60000, // 60s per test — staging cold starts can be slow
  use: {
    baseURL: process.env.STAGING_URL || 'https://staging.freshwax.pages.dev',
    trace: 'on-first-retry',
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  // No webServer — testing against deployed staging environment
});
