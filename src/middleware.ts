// src/middleware.ts
// Initialize Firebase env from Cloudflare runtime on every request
// Add security headers and CORS to all responses
import { defineMiddleware } from 'astro:middleware';
import { initFirebaseEnv } from './lib/firebase-rest';

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

// Security headers to apply to all responses
const securityHeaders: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-XSS-Protection': '1; mode=block',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: https://www.gstatic.com https://js.pusher.com https://cdn.jsdelivr.net https://www.googletagmanager.com https://www.google-analytics.com https://www.youtube.com https://player.vimeo.com https://w.soundcloud.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https: data: blob:; connect-src 'self' https://firestore.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://*.pusher.com wss://*.pusher.com https://api.stripe.com https://*.cloudflare.com https://*.r2.cloudflarestorage.com https://www.google-analytics.com https://*.google-analytics.com https://www.googletagmanager.com https://www.gstatic.com https://cdn.jsdelivr.net https://*.trycloudflare.com https://stream.freshwax.co.uk https://stream.freshwax.co.uk:9997 https://rtmp.freshwax.co.uk https://icecast.freshwax.co.uk https://noembed.com https://api.giphy.com; frame-src 'self' https://js.stripe.com https://www.youtube.com https://player.vimeo.com https://w.soundcloud.com https://freshwax-uploader.pages.dev https://www.twitch.tv https://player.twitch.tv https://embed.twitch.tv; media-src 'self' https: blob: http://localhost:8000; object-src 'none'; base-uri 'self'; form-action 'self';"
};

export const onRequest = defineMiddleware(async ({ locals, request }, next) => {
  // Get Cloudflare runtime env and initialize Firebase
  const runtime = (locals as any).runtime;
  if (runtime?.env) {
    initFirebaseEnv(runtime.env);
  }

  const url = new URL(request.url);
  const isApiRoute = url.pathname.startsWith('/api/');
  const origin = request.headers.get('origin');

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

  // Get the response
  const response = await next();

  // Clone headers for modification
  const newHeaders = new Headers(response.headers);

  // Add CORS headers to API responses
  if (isApiRoute) {
    const corsHeaders = getCorsHeaders(origin);
    for (const [key, value] of Object.entries(corsHeaders)) {
      newHeaders.set(key, value);
    }
  }

  // Add security headers to HTML responses
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    for (const [key, value] of Object.entries(securityHeaders)) {
      newHeaders.set(key, value);
    }
  }

  // Return modified response if headers changed
  if (isApiRoute || contentType.includes('text/html')) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });
  }

  return response;
});
