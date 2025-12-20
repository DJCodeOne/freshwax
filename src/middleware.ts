// src/middleware.ts
// Initialize Firebase env from Cloudflare runtime on every request
// Add security headers to all responses
import { defineMiddleware } from 'astro:middleware';
import { initFirebaseEnv } from './lib/firebase-rest';

// Security headers to apply to all responses
const securityHeaders: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-XSS-Protection': '1; mode=block',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.gstatic.com https://js.pusher.com https://cdn.jsdelivr.net https://www.googletagmanager.com https://www.google-analytics.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https: data: blob:; connect-src 'self' https://firestore.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://*.pusher.com wss://*.pusher.com https://api.stripe.com https://*.cloudflare.com https://*.r2.cloudflarestorage.com; frame-src 'self' https://js.stripe.com https://www.youtube.com; media-src 'self' https: blob:; object-src 'none'; base-uri 'self'; form-action 'self';"
};

export const onRequest = defineMiddleware(async ({ locals, request }, next) => {
  // Get Cloudflare runtime env and initialize Firebase
  const runtime = (locals as any).runtime;
  if (runtime?.env) {
    initFirebaseEnv(runtime.env);
  }

  // Get the response
  const response = await next();

  // Add security headers to all HTML responses
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    // Clone response to modify headers
    const newHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(securityHeaders)) {
      newHeaders.set(key, value);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });
  }

  return response;
});
