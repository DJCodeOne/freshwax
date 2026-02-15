// src/middleware.ts
// Initialize Firebase env from Cloudflare runtime on every request
// Add security headers and CORS to all responses
import { defineMiddleware } from 'astro:middleware';
import { initFirebaseEnv } from './lib/firebase-rest';
import { initKVCache } from './lib/kv-cache';
import { initRateLimitKV, checkRateLimit, getClientId, rateLimitResponse } from './lib/rate-limit';
import { logServerError } from './lib/error-logger';

// Allowed origins for CORS
const ALLOWED_ORIGINS = [
  'https://freshwax.co.uk',
  'https://www.freshwax.co.uk',
  'https://freshwax.pages.dev',
  'https://stream.freshwax.co.uk',
  'https://icecast.freshwax.co.uk',
  // Development
  'http://localhost:4321',
  'http://localhost:3000',
  'http://127.0.0.1:4321',
];

// Check if origin is allowed
function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  // Allow any *.freshwax.pages.dev preview deployments
  if (origin.endsWith('.freshwax.pages.dev')) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

// Get CORS headers for a request
function getCorsHeaders(origin: string | null): Record<string, string> {
  if (isAllowedOrigin(origin)) {
    return {
      'Access-Control-Allow-Origin': origin!,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '86400', // 24 hours
    };
  }
  return {};
}

// --- API Rate Limiting Tiers ---
// Endpoints to SKIP rate limiting entirely (they have their own verification)
const RATE_LIMIT_SKIP = new Set([
  '/api/stripe/webhook',
  '/api/stripe/connect/webhook',
  '/api/livestream/red5-webhook',
  '/api/icecast-auth',
  '/api/cron/cleanup-reservations',
  '/api/cron/retry-payouts',
  '/api/cron/send-restock-notifications',
  '/api/cron/stock-alerts',
  '/api/health/index',
  '/api/health/payments',
]);

// Tight limit: search & external proxies (30 req/min)
const RATE_LIMIT_TIGHT_PREFIXES = [
  '/api/search-releases',
  '/api/giphy/',
  '/api/youtube/',
  '/api/postcode-lookup',
];

// Download limit (20 req/min, 1-min block)
const RATE_LIMIT_DOWNLOAD_PREFIXES = [
  '/api/download',      // matches /api/download and /api/download-mix
  '/api/presign-download',
];

// Metrics/tracking (60 req/min — prevent inflation)
const RATE_LIMIT_METRICS_PREFIXES = [
  '/api/track-mix-play',
  '/api/track-mix-download',
  '/api/track-mix-unlike',
  '/api/track-mix-like',
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
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-XSS-Protection': '1; mode=block',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
};

export const onRequest = defineMiddleware(async ({ locals, request }, next) => {
  // Generate CSP nonce for this request
  const nonce = crypto.randomUUID().replace(/-/g, '');
  (locals as any).nonce = nonce;

  // Get Cloudflare runtime env and initialize Firebase
  const runtime = (locals as any).runtime;
  if (runtime?.env) {
    initFirebaseEnv(runtime.env);
    initKVCache(runtime.env);
    initRateLimitKV(runtime.env?.CACHE || runtime.env?.KV);
  }

  const url = new URL(request.url);

  // WWW canonicalization — redirect www to non-www
  if (url.hostname === 'www.freshwax.co.uk') {
    url.hostname = 'freshwax.co.uk';
    return new Response(null, {
      status: 301,
      headers: { 'Location': url.toString() }
    });
  }

  // Trailing slash canonicalization — redirect /path to /path/ for SEO consistency
  // Skip: root, API routes, files with extensions, paths already ending with /
  const { pathname } = url;
  if (
    pathname !== '/' &&
    !pathname.startsWith('/api/') &&
    !pathname.endsWith('/') &&
    !pathname.split('/').pop()?.includes('.')
  ) {
    url.pathname = pathname + '/';
    return new Response(null, {
      status: 301,
      headers: { 'Location': url.toString() }
    });
  }

  const isApiRoute = pathname.startsWith('/api/');
  const origin = request.headers.get('origin');

  // --- API Rate Limiting (before any handler runs) ---
  if (isApiRoute && request.method !== 'OPTIONS') {
    const rlResult = apiRateLimit(pathname, request);
    if (rlResult) return rlResult;
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
  } catch (err) {
    // Unhandled exception in API handler
    if (isApiRoute) {
      const env = (locals as any)?.runtime?.env;
      logServerError(err, request, env, { endpoint: pathname, statusCode: 500 }).catch(() => {});
    }
    throw err; // Re-throw to let Astro handle the error page
  }

  // Log 5xx API responses
  if (isApiRoute && response.status >= 500) {
    const env = (locals as any)?.runtime?.env;
    logServerError(new Error(`${response.status} ${response.statusText || 'Server Error'}`), request, env, {
      endpoint: pathname,
      statusCode: response.status,
    }).catch(() => {});
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
  if (contentType.includes('text/html')) {
    for (const [key, value] of Object.entries(securityHeaders)) {
      newHeaders.set(key, value);
    }
    // Build CSP with per-request nonce — all inline scripts use nonce={nonce} attribute.
    // 'unsafe-inline' is kept as fallback for older browsers that don't support nonces;
    // modern browsers ignore 'unsafe-inline' when a nonce is present (CSP spec).
    const csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'unsafe-inline' blob: data: https://www.gstatic.com https://www.google.com https://apis.google.com https://translate.google.com https://translate.googleapis.com https://translate-pa.googleapis.com https://js.pusher.com https://cdn.jsdelivr.net https://unpkg.com https://www.googletagmanager.com https://www.google-analytics.com https://www.youtube.com https://player.vimeo.com https://w.soundcloud.com https://www.paypal.com https://js.stripe.com https://checkout.stripe.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://translate.googleapis.com https://www.gstatic.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https: data: blob:; connect-src 'self' blob: https://firestore.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://*.pusher.com wss://*.pusher.com https://api.stripe.com https://*.stripe.com https://*.cloudflare.com https://*.r2.cloudflarestorage.com https://www.google-analytics.com https://*.google-analytics.com https://www.googletagmanager.com https://www.gstatic.com https://www.google.com https://cdn.jsdelivr.net https://unpkg.com https://*.trycloudflare.com https://stream.freshwax.co.uk https://stream.freshwax.co.uk:9997 https://rtmp.freshwax.co.uk https://icecast.freshwax.co.uk https://playlist.freshwax.co.uk https://cdn.freshwax.co.uk https://noembed.com https://api.giphy.com https://www.paypal.com https://*.paypal.com https://www.youtube.com https://vinyl-api.davidhagon.workers.dev https://translate.google.com https://translate.googleapis.com https://translate-pa.googleapis.com; frame-src 'self' https://js.stripe.com https://checkout.stripe.com https://www.youtube.com https://player.vimeo.com https://w.soundcloud.com https://freshwax-uploader-9ge.pages.dev https://www.twitch.tv https://player.twitch.tv https://embed.twitch.tv https://www.paypal.com https://*.paypal.com https://www.google.com https://accounts.google.com https://freshwax-store.firebaseapp.com; media-src 'self' https: blob:; object-src 'none'; base-uri 'self'; form-action 'self';`;
    newHeaders.set('Content-Security-Policy', csp);
  }

  // Add basic security headers to ALL responses (JS, CSS, SVG, etc.)
  newHeaders.set('X-Content-Type-Options', 'nosniff');
  newHeaders.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');

  // Return modified response
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
});
