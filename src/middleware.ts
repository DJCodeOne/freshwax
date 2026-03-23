// src/middleware.ts
// Initialize Firebase env from Cloudflare runtime on every request
// Add security headers, CORS, and CSRF protection to all responses
import { defineMiddleware } from 'astro:middleware';
import { initFirebaseEnv } from './lib/firebase-rest';
import { initKVCache } from './lib/kv-cache';
import { initRateLimitKV, checkRateLimit, getClientId, rateLimitResponse } from './lib/rate-limit';
import { logServerError } from './lib/error-logger';
import { SITE_URL } from './lib/constants';
import {
  generateCsrfToken,
  getCsrfCookie,
  getSubmittedCsrfToken,
  validateCsrfToken,
  buildCsrfCookie,
  shouldSkipCsrf,
} from './lib/csrf';

// Endpoints that bypass Content-Type validation (they have their own body parsing)
const CONTENT_TYPE_SKIP = new Set([
  '/api/stripe/webhook/',
  '/api/stripe/connect/webhook/',
  '/api/paypal/webhook/',
  '/api/livestream/red5-webhook/',
  '/api/livestream/whip-proxy/',
]);

// Allowed Content-Type prefixes for POST/PUT/PATCH requests
const ALLOWED_CONTENT_TYPES = [
  'application/json',
  'multipart/form-data',
  'application/x-www-form-urlencoded',
];

// Max JSON body size: 2 MB
const MAX_JSON_BODY_SIZE = 2 * 1024 * 1024;

// Allowed origins for CORS
const ALLOWED_ORIGINS = [
  SITE_URL,
  SITE_URL.replace('https://', 'https://www.'),
  'https://freshwax.pages.dev',
  'https://stream.freshwax.co.uk',
  'https://icecast.freshwax.co.uk',
];

// Cloudflare Pages preview URL pattern: https://<hex-hash>.freshwax.pages.dev
// Only alphanumeric + hyphens allowed in the subdomain portion.
// SECURITY TRADE-OFF: Preview deployments are only created from the git repo
// (push access required), so an attacker cannot mint arbitrary subdomains.
// This is acceptable because: (1) Cloudflare controls the *.pages.dev namespace,
// (2) only repo collaborators can trigger deployments, (3) preview URLs are
// short-lived. Credentials mode IS enabled, so preview deploys CAN send
// authenticated requests — this is intentional for testing auth flows.
const PAGES_PREVIEW_RE = /^https:\/\/[a-z0-9][a-z0-9-]{0,62}\.freshwax\.pages\.dev$/;

// Check if origin is allowed
function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (PAGES_PREVIEW_RE.test(origin)) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

// Get CORS headers for a request
function getCorsHeaders(origin: string | null): Record<string, string> {
  if (isAllowedOrigin(origin)) {
    return {
      'Access-Control-Allow-Origin': origin!,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-CSRF-Token',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '86400', // 24 hours
    };
  }
  return {};
}

// --- API Rate Limiting Tiers ---
// Endpoints to SKIP rate limiting entirely (they have their own verification)
const RATE_LIMIT_SKIP = new Set([
  '/api/stripe/webhook/',
  '/api/stripe/connect/webhook/',
  '/api/livestream/red5-webhook/',
  '/api/icecast-auth/',
  '/api/cron/cleanup-reservations/',
  '/api/cron/retry-payouts/',
  '/api/cron/send-restock-notifications/',
  '/api/cron/image-scan/',
  '/api/cron/verification-reminders/',
  '/api/cron/cleanup-d1/',
  '/api/cron/backup-d1/',
  '/api/health/index/',
  '/api/health/payments/',
  '/api/cron/weekly-digest/',
]);

// Tight limit: search & external proxies (30 req/min)
const RATE_LIMIT_TIGHT_PREFIXES = [
  '/api/search-releases/',
  '/api/giphy/',
  '/api/youtube/',
  '/api/postcode-lookup/',
];

// Download limit (20 req/min, 1-min block)
const RATE_LIMIT_DOWNLOAD_PREFIXES = [
  '/api/download/',
  '/api/download-mix/',
  '/api/presign-download/',
];

// Metrics/tracking (60 req/min — prevent inflation)
const RATE_LIMIT_METRICS_PREFIXES = [
  '/api/track-mix-play/',
  '/api/track-mix-download/',
  '/api/track-mix-unlike/',
  '/api/track-mix-like/',
];

function apiRateLimit(pathname: string, request: Request): Response | null {
  // Skip webhooks, cron, health checks
  if (RATE_LIMIT_SKIP.has(pathname)) return null;

  const clientId = getClientId(request);

  // Tight: search & proxy endpoints
  for (const prefix of RATE_LIMIT_TIGHT_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      const result = checkRateLimit(`api-tight:${clientId}:${prefix}`, {
        maxRequests: 30,
        windowMs: 60_000,
      });
      return result.allowed ? null : rateLimitResponse(result.retryAfter!);
    }
  }

  // Downloads
  for (const prefix of RATE_LIMIT_DOWNLOAD_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      const result = checkRateLimit(`api-dl:${clientId}`, {
        maxRequests: 20,
        windowMs: 60_000,
        blockDurationMs: 60_000,
      });
      return result.allowed ? null : rateLimitResponse(result.retryAfter!);
    }
  }

  // Metrics tracking
  for (const prefix of RATE_LIMIT_METRICS_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      const result = checkRateLimit(`api-metrics:${clientId}`, {
        maxRequests: 60,
        windowMs: 60_000,
      });
      return result.allowed ? null : rateLimitResponse(result.retryAfter!);
    }
  }

  // Global catch-all: 120 req/min for reads, 60 req/min for writes
  const isWrite = request.method !== 'GET' && request.method !== 'HEAD';
  const globalKey = isWrite ? `api-w:${clientId}` : `api-r:${clientId}`;
  const globalLimit = isWrite ? 60 : 120;

  const result = checkRateLimit(globalKey, {
    maxRequests: globalLimit,
    windowMs: 60_000,
  });

  return result.allowed ? null : rateLimitResponse(result.retryAfter!);
}

// Security headers to apply to all responses (CSP is added dynamically per-request)
const securityHeaders: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(), payment=(), interest-cohort=(), browsing-topics=(), usb=(), bluetooth=(), serial=(), hid=()',
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'X-XSS-Protection': '0',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
};

export const onRequest = defineMiddleware(async ({ locals, request }, next) => {
  // Get Cloudflare runtime env and initialize Firebase
  const runtime = locals.runtime;
  if (runtime?.env) {
    initFirebaseEnv(runtime.env);
    initKVCache(runtime.env);
    initRateLimitKV(runtime.env?.CACHE || runtime.env?.KV);
  }

  // --- CSP Nonce (generated per request for script-src) ---
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonceStr = Array.from(nonceBytes, (b: number) => b.toString(16).padStart(2, '0')).join('');
  locals.nonce = nonceStr;

  // --- CSRF Token (double-submit cookie pattern) ---
  // Reuse existing cookie token or generate a fresh one.
  const existingCsrfToken = getCsrfCookie(request);
  const csrfToken = existingCsrfToken || generateCsrfToken();
  locals.csrfToken = csrfToken;
  const isSecure = request.url.startsWith('https');

  const url = new URL(request.url);

  // WWW canonicalization — redirect www to non-www
  const siteHostname = new URL(SITE_URL).hostname;
  if (url.hostname === `www.${siteHostname}`) {
    url.hostname = siteHostname;
    return new Response(null, {
      status: 301,
      headers: { 'Location': url.toString() }
    });
  }

  // Trailing slash canonicalization — redirect /path/ for consistency
  // Astro trailingSlash:'always' registers routes with trailing slash,
  // so requests without it get 404. Redirect all paths (including API).
  // Use 308 for POST/PUT/DELETE (preserves method+body), 301 for GET/HEAD.
  const { pathname } = url;
  if (
    pathname !== '/' &&
    !pathname.endsWith('/') &&
    !pathname.split('/').pop()?.includes('.')
  ) {
    url.pathname = pathname + '/';
    const isGetOrHead = request.method === 'GET' || request.method === 'HEAD';
    return new Response(null, {
      status: isGetOrHead ? 301 : 308,
      headers: { 'Location': url.toString() }
    });
  }

  // Skip middleware for static assets (CSS, JS, images, fonts, etc.)
  // Cloudflare CDN handles caching and headers for these
  const lastSegment = pathname.split('/').pop() || '';
  if (lastSegment.includes('.')) {
    return next();
  }

  const isApiRoute = pathname.startsWith('/api/');
  const origin = request.headers.get('origin');

  // --- API Rate Limiting (before any handler runs) ---
  if (isApiRoute && request.method !== 'OPTIONS') {
    const rlResult = apiRateLimit(pathname, request);
    if (rlResult) return rlResult;
  }

  // --- Content-Type validation & JSON body size limit for API write requests ---
  if (
    isApiRoute &&
    (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') &&
    !CONTENT_TYPE_SKIP.has(pathname)
  ) {
    const contentLength = request.headers.get('content-length');
    const hasBody = contentLength !== null && contentLength !== '0';

    if (hasBody) {
      const ct = (request.headers.get('content-type') || '').toLowerCase();
      const isAllowedType = ALLOWED_CONTENT_TYPES.some((allowed) => ct.startsWith(allowed));

      if (!isAllowedType) {
        return new Response(
          JSON.stringify({ success: false, error: 'Unsupported Media Type. Expected application/json, multipart/form-data, or application/x-www-form-urlencoded.' }),
          { status: 415, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Reject oversized JSON payloads
      if (ct.startsWith('application/json') && parseInt(contentLength, 10) > MAX_JSON_BODY_SIZE) {
        return new Response(
          JSON.stringify({ success: false, error: 'Payload Too Large. JSON body must not exceed 2 MB.' }),
          { status: 413, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }
  }

  // --- CSRF Validation for state-changing requests ---
  // Validates double-submit cookie: cookie value must match header or body field.
  // API routes: check X-CSRF-Token header (set by global fetch interceptor).
  // Page routes: check _csrf form field (for traditional <form method="POST">).
  const isStateChanging = request.method === 'POST' || request.method === 'PUT' ||
                          request.method === 'PATCH' || request.method === 'DELETE';
  if (isStateChanging && !shouldSkipCsrf(pathname)) {
    let submittedToken = getSubmittedCsrfToken(request);

    // For non-API page POSTs with form-urlencoded body, parse _csrf from the body.
    // We clone the request so downstream handlers can still read the body.
    if (!submittedToken && !isApiRoute) {
      const ct = (request.headers.get('content-type') || '').toLowerCase();
      if (ct.startsWith('application/x-www-form-urlencoded') || ct.startsWith('multipart/form-data')) {
        try {
          const cloned = request.clone();
          const formData = await cloned.formData();
          const csrfField = formData.get('_csrf');
          if (typeof csrfField === 'string') {
            submittedToken = csrfField;
          }
        } catch (_e: unknown) {
          // non-critical: body parse failed — token stays null, validation will reject
        }
      }
    }

    if (!validateCsrfToken(existingCsrfToken, submittedToken)) {
      if (isApiRoute) {
        return new Response(
          JSON.stringify({ success: false, error: 'CSRF token mismatch' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }
      // For page routes, return a simple HTML error
      return new Response(
        '<html><body><h1>403 Forbidden</h1><p>CSRF token validation failed. Please go back and try again.</p></body></html>',
        { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    }
  }

  // Handle CORS preflight for API routes
  if (isApiRoute && request.method === 'OPTIONS') {
    const corsHeaders = getCorsHeaders(origin);
    if (Object.keys(corsHeaders).length > 0) {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }
    // Reject preflight from unknown origins
    return new Response(null, { status: 403 });
  }

  // Get the response — log server errors for API routes
  let response: Response;
  try {
    response = await next();
  } catch (err: unknown) {
    // Unhandled exception in API handler
    if (isApiRoute) {
      const env = locals.runtime?.env;
      logServerError(err, request, env, { endpoint: pathname, statusCode: 500 }).catch(() => { /* non-critical: error logging */ });
    }
    throw err; // Re-throw to let Astro handle the error page
  }

  // Log 5xx API responses
  if (isApiRoute && response.status >= 500) {
    const env = locals.runtime?.env;
    logServerError(new Error(`${response.status} ${response.statusText || 'Server Error'}`), request, env, {
      endpoint: pathname,
      statusCode: response.status,
    }).catch(() => { /* non-critical: error logging */ });
  }

  // Clone headers for modification
  const newHeaders = new Headers(response.headers);

  // Add CORS headers to API responses
  if (isApiRoute) {
    const corsHeaders = getCorsHeaders(origin);
    for (const [key, value] of Object.entries(corsHeaders)) {
      newHeaders.set(key, value);
    }
    // Add security headers to API responses
    newHeaders.set('X-Content-Type-Options', 'nosniff');
    newHeaders.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    newHeaders.set('X-Frame-Options', 'DENY');
  }

  // Add security headers to HTML responses
  const contentType = response.headers.get('content-type') || '';
  const isHtml = contentType.includes('text/html');
  if (isHtml) {
    for (const [key, value] of Object.entries(securityHeaders)) {
      newHeaders.set(key, value);
    }
    // Build CSP with per-request nonce for script-src.
    // 'strict-dynamic' propagates trust from nonce'd scripts to their dynamically loaded
    // children (e.g. Astro Vite-bundled module scripts loaded via nonce'd parent).
    // 'unsafe-inline' is kept as a fallback for browsers that don't support nonces
    // (modern browsers ignore 'unsafe-inline' when a nonce or 'strict-dynamic' is present).
    // https: is kept as a fallback for browsers that don't support 'strict-dynamic'.
    // Add default Cache-Control for HTML if not already set by the page
    if (!newHeaders.has('Cache-Control')) {
      newHeaders.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    }
    const csp = `default-src 'self'; script-src 'nonce-${nonceStr}' 'strict-dynamic' 'unsafe-inline' https:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://translate.googleapis.com https://www.gstatic.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https: data: blob:; connect-src 'self' blob: https://firestore.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://*.pusher.com wss://*.pusher.com https://api.stripe.com https://*.stripe.com https://*.cloudflare.com https://*.r2.cloudflarestorage.com https://www.google-analytics.com https://*.google-analytics.com https://www.googletagmanager.com https://www.gstatic.com https://www.google.com https://cdn.jsdelivr.net https://unpkg.com https://*.trycloudflare.com https://stream.freshwax.co.uk https://stream.freshwax.co.uk:8889 https://stream.freshwax.co.uk:9997 https://rtmp.freshwax.co.uk https://icecast.freshwax.co.uk https://playlist.freshwax.co.uk https://cdn.freshwax.co.uk https://noembed.com https://api.giphy.com https://www.paypal.com https://*.paypal.com https://www.youtube.com https://vinyl-api.davidhagon.workers.dev https://translate.google.com https://translate.googleapis.com https://translate-pa.googleapis.com; frame-src 'self' https://js.stripe.com https://checkout.stripe.com https://www.youtube.com https://player.vimeo.com https://w.soundcloud.com https://freshwax-uploader-9ge.pages.dev https://www.twitch.tv https://player.twitch.tv https://embed.twitch.tv https://www.paypal.com https://*.paypal.com https://www.google.com https://accounts.google.com https://freshwax-store.firebaseapp.com; media-src 'self' https: blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none';`;
    newHeaders.set('Content-Security-Policy', csp);
  }

  // Add basic security headers to ALL responses (JS, CSS, SVG, etc.)
  newHeaders.set('X-Content-Type-Options', 'nosniff');
  newHeaders.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');

  // Set CSRF cookie on every response (refresh token)
  newHeaders.append('Set-Cookie', buildCsrfCookie(csrfToken, isSecure));

  // --- Inject nonce into all <script> tags in HTML responses ---
  // Astro's Vite-processed <script> tags (hoisted modules) don't get nonce attributes
  // automatically. This middleware rewrites the HTML to add nonce to ALL <script> tags
  // that lack one, enabling 'unsafe-inline' removal from CSP script-src.
  if (isHtml && response.body) {
    const html = await response.text();
    // Match <script tags that don't already have a nonce attribute
    const nonceAttr = ` nonce="${nonceStr}"`;
    const injected = html.replace(/<script(?![^>]*\bnonce\b)/gi, '<script' + nonceAttr);
    return new Response(injected, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });
  }

  // Return modified response (non-HTML or empty body)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
});
