// src/pages/api/download-mix.ts
import type { APIRoute } from 'astro';
import { verifyRequestUser } from '../../lib/firebase-rest';
import { errorResponse, ApiErrors } from '../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

// Only allow downloads from trusted domains
const ALLOWED_DOMAINS = [
  'playlist.freshwax.co.uk',
  'cdn.freshwax.co.uk',
  'pub-5c0458d0721c4946884a203f2ca66ee0.r2.dev',
  'firebasestorage.googleapis.com',
];

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`download-mix:${clientId}`, RateLimiters.strict);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;


  // SECURITY: Require authentication
  const { userId, error: authError } = await verifyRequestUser(request);
  if (!userId || authError) {
    return ApiErrors.unauthorized('Authentication required');
  }

  const url = new URL(request.url);
  const audioUrl = url.searchParams.get('url');
  // SECURITY: Sanitize filename to prevent CRLF header injection
  const rawFilename = url.searchParams.get('filename') || 'download.mp3';
  const filename = rawFilename.replace(/[^a-zA-Z0-9._\-() ]/g, '_').slice(0, 200);

  if (!audioUrl) {
    return ApiErrors.badRequest('Missing audio URL');
  }

  // SECURITY: Validate URL is from allowed domains only, https required
  let isAllowed = false;
  try {
    const parsedUrl = new URL(audioUrl);
    if (parsedUrl.protocol !== 'https:') {
      return ApiErrors.badRequest('Only HTTPS URLs allowed');
    }
    isAllowed = ALLOWED_DOMAINS.some(domain => parsedUrl.hostname === domain || parsedUrl.hostname.endsWith('.' + domain));
  } catch {
    return ApiErrors.badRequest('Invalid URL');
  }

  if (!isAllowed) {
    return ApiErrors.forbidden('Domain not allowed');
  }

  try {
    log.info('[download-mix] Proxying download for:', audioUrl);

    const response = await fetch(audioUrl, {
      signal: AbortSignal.timeout(30000) // 30s timeout
    });

    if (!response.ok) {
      throw new Error('Failed to fetch: ' + response.status);
    }

    // Stream the response instead of buffering to handle large files
    const contentLength = response.headers.get('content-length');

    log.info('[download-mix] Streaming file, size:', contentLength || 'unknown');

    const headers: Record<string, string> = {
      'Content-Type': 'audio/mpeg',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-cache'
    };

    if (contentLength) {
      headers['Content-Length'] = contentLength;
    }

    // Pass through the body stream directly
    return new Response(response.body, {
      status: 200,
      headers
    });

  } catch (error: unknown) {
    log.error('[download-mix] Error:', error);
    return ApiErrors.serverError('Failed to download file');
  }
};