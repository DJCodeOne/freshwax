// src/lib/csrf.ts
// Double-submit cookie CSRF protection
//
// Defense-in-depth layer on top of Astro's `security: { checkOrigin: true }`.
//
// Flow:
//  1. Middleware generates a random token per request (or reuses existing cookie).
//  2. Token is set as a `__csrf` cookie (SameSite=Strict, Secure in prod).
//  3. Token is stored in `Astro.locals.csrfToken` so pages can embed it.
//  4. Layout.astro renders a <meta name="csrf-token"> tag.
//  5. Client-side JS reads the meta tag and sends the token as `X-CSRF-Token`
//     header on every state-changing fetch() call (via global interceptor).
//  6. For traditional form POSTs, a hidden `_csrf` input is included.
//  7. Middleware validates: cookie value === header or body field value.
//
// Endpoints that are exempt (they use their own authentication):
//  - Stripe/PayPal webhooks
//  - Red5 / Icecast webhooks
//  - Cron jobs (Bearer token auth)
//  - Health checks

import { timingSafeCompare } from './api-utils';

// Endpoints that skip CSRF validation entirely
// These use their own authentication (webhook signatures, cron secrets, etc.)
const CSRF_SKIP = new Set([
  '/api/stripe/webhook/',
  '/api/stripe/connect/webhook/',
  '/api/paypal/webhook/',
  '/api/livestream/red5-webhook/',
  '/api/icecast-auth/',
  '/api/cron/cleanup-reservations/',
  '/api/cron/retry-payouts/',
  '/api/cron/send-restock-notifications/',
  '/api/cron/image-scan/',
  '/api/cron/verification-reminders/',
  '/api/cron/cleanup-d1/',
  '/api/cron/stock-alerts/',
  '/api/health/index/',
  '/api/health/payments/',
  // Pusher channel auth — Pusher JS library uses its own XHR transport,
  // not the global fetch() interceptor, so it lacks the X-CSRF-Token header.
  // The endpoint validates session auth independently.
  '/api/dj-lobby/pusher-auth/',
  // Error logging & consent logging are fire-and-forget from inline scripts
  // that run before the meta tag is available (e.g. Layout.astro error handler).
  '/api/log-error/',
  '/api/consent-log/',
]);

/**
 * Check if a pathname should skip CSRF validation.
 */
export function shouldSkipCsrf(pathname: string): boolean {
  return CSRF_SKIP.has(pathname);
}

/**
 * Generate a cryptographically random CSRF token (32 hex chars).
 */
export function generateCsrfToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Read the CSRF token from the `__csrf` cookie on the incoming request.
 */
export function getCsrfCookie(request: Request): string | null {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return null;

  // Parse cookies (simple parser — handles standard format)
  const cookies = cookieHeader.split(';');
  for (const cookie of cookies) {
    const [name, ...rest] = cookie.split('=');
    if (name.trim() === '__csrf') {
      return rest.join('=').trim() || null;
    }
  }
  return null;
}

/**
 * Read the CSRF token submitted by the client.
 * Checks X-CSRF-Token header first, then falls back to _csrf body field.
 */
export function getSubmittedCsrfToken(
  request: Request,
  parsedBody?: Record<string, unknown> | null
): string | null {
  // 1. Check header (preferred — used by fetch() calls)
  const headerToken = request.headers.get('X-CSRF-Token');
  if (headerToken) return headerToken;

  // 2. Check body field (for traditional form submissions)
  if (parsedBody && typeof parsedBody._csrf === 'string') {
    return parsedBody._csrf;
  }

  return null;
}

/**
 * Validate that the submitted CSRF token matches the cookie token.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function validateCsrfToken(
  cookieToken: string | null,
  submittedToken: string | null
): boolean {
  if (!cookieToken || !submittedToken) return false;
  if (cookieToken.length === 0 || submittedToken.length === 0) return false;
  return timingSafeCompare(cookieToken, submittedToken);
}

/**
 * Build the Set-Cookie header value for the CSRF token.
 */
export function buildCsrfCookie(token: string, isSecure: boolean): string {
  // SameSite=Lax allows the cookie to be sent on top-level navigations (form submits)
  // while still blocking cross-origin subrequests.
  // NOT HttpOnly — client-side JS needs to read it from the meta tag (not the cookie),
  // but the cookie itself can be HttpOnly since we use a meta tag to expose the value.
  const parts = [
    `__csrf=${token}`,
    'Path=/',
    'SameSite=Lax',
    'HttpOnly',
  ];
  if (isSecure) {
    parts.push('Secure');
  }
  // 24-hour expiry (token refreshes on each request)
  parts.push('Max-Age=86400');
  return parts.join('; ');
}
