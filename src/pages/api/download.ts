// src/pages/api/download.ts
// Server-side download proxy to bypass CORS for R2 files

import type { APIRoute } from 'astro';
import { verifyRequestUser, queryCollection } from '../../lib/firebase-rest';
import { errorResponse, ApiErrors, fetchWithTimeout } from '../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

export const GET: APIRoute = async ({ request, url, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`download:${clientId}`, RateLimiters.strict);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;

  // Initialize Firebase for auth verification


  // SECURITY: Require authentication - downloads are for purchased content
  const { userId, error: authError } = await verifyRequestUser(request);
  if (authError || !userId) {
    return ApiErrors.unauthorized(authError || 'Authentication required');
  }

  const fileUrl = url.searchParams.get('url');
  const filename = url.searchParams.get('filename') || 'download';

  if (!fileUrl) {
    return ApiErrors.badRequest('Missing url parameter');
  }
  
  // Validate URL is from allowed domains
  const allowedDomains = [
    'pub-5c0458d0721c4946884a203f2ca66ee0.r2.dev',
    'cdn.freshwax.co.uk',
    'firebasestorage.googleapis.com',
    'r2.cloudflarestorage.com' // For presigned R2 URLs
  ];
  
  let isAllowed = false;
  try {
    const parsedUrl = new URL(fileUrl);
    isAllowed = allowedDomains.some(domain => parsedUrl.hostname === domain || parsedUrl.hostname.endsWith('.' + domain));
  } catch (e) {
    return ApiErrors.badRequest('Invalid URL');
  }

  if (!isAllowed) {
    return ApiErrors.forbidden('Domain not allowed');
  }

  // SECURITY: Verify user has purchased content containing this URL
  try {
    const userOrders = await queryCollection('orders', {
      filters: [
        { field: 'customerId', op: 'EQUAL', value: userId },
        { field: 'paymentStatus', op: 'EQUAL', value: 'completed' }
      ],
      limit: 500
    });

    const hasPurchased = userOrders.some((order: any) =>
      (order.items || []).some((item: any) => {
        const tracks = item.downloads?.tracks || [];
        return tracks.some((t: any) => t.mp3Url === fileUrl || t.wavUrl === fileUrl) ||
          item.downloads?.artworkUrl === fileUrl;
      })
    );

    if (!hasPurchased) {
      return ApiErrors.forbidden('Purchase required');
    }
  } catch (purchaseErr) {
    log.error('[download] Purchase verification error:', purchaseErr);
    return errorResponse('Could not verify purchase');
  }

  try {
    log.info('[download] Fetching:', fileUrl);

    const response = await fetchWithTimeout(fileUrl, {}, 30000);

    if (!response.ok) {
      log.error('[download] Fetch failed:', response.status);
      return errorResponse('Failed to fetch file', response.status);
    }

    let contentType = response.headers.get('content-type') || 'application/octet-stream';

    if (filename.endsWith('.mp3')) {
      contentType = 'audio/mpeg';
    } else if (filename.endsWith('.wav')) {
      contentType = 'audio/wav';
    } else if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) {
      contentType = 'image/jpeg';
    } else if (filename.endsWith('.png')) {
      contentType = 'image/png';
    } else if (filename.endsWith('.webp')) {
      contentType = 'image/webp';
    }

    // Stream the response instead of buffering to handle large files
    const contentLength = response.headers.get('content-length');

    log.info('[download] Streaming file, size:', contentLength || 'unknown');

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      'Cache-Control': 'private, max-age=3600'
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
    log.error('[download] Error:', error);
    return errorResponse('Download failed');
  }
};