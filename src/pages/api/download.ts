// src/pages/api/download.ts
// Server-side download proxy to bypass CORS for R2 files

import type { APIRoute } from 'astro';
import { verifyRequestUser, initFirebaseEnv, queryCollection } from '../../lib/firebase-rest';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

export const GET: APIRoute = async ({ request, url, locals }) => {
  const env = (locals as any)?.runtime?.env;

  // Initialize Firebase for auth verification
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  // SECURITY: Require authentication - downloads are for purchased content
  const { userId, error: authError } = await verifyRequestUser(request);
  if (authError || !userId) {
    return new Response(JSON.stringify({
      success: false,
      error: authError || 'Authentication required'
    }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  const fileUrl = url.searchParams.get('url');
  const filename = url.searchParams.get('filename') || 'download';
  
  if (!fileUrl) {
    return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
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
    return new Response(JSON.stringify({ error: 'Invalid URL' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  if (!isAllowed) {
    return new Response(JSON.stringify({ error: 'Domain not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // SECURITY: Verify user has purchased content containing this URL
  try {
    const userOrders = await queryCollection('orders', {
      filters: [
        { field: 'customerId', op: 'EQUAL', value: userId },
        { field: 'paymentStatus', op: 'EQUAL', value: 'completed' }
      ],
      limit: 50
    });

    const hasPurchased = userOrders.some((order: any) =>
      (order.items || []).some((item: any) => {
        const tracks = item.downloads?.tracks || [];
        return tracks.some((t: any) => t.mp3Url === fileUrl || t.wavUrl === fileUrl) ||
          item.downloads?.artworkUrl === fileUrl;
      })
    );

    if (!hasPurchased) {
      return new Response(JSON.stringify({ error: 'Purchase required' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch (purchaseErr) {
    log.error('[download] Purchase verification error:', purchaseErr);
    return new Response(JSON.stringify({ error: 'Could not verify purchase' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    log.info('[download] Fetching:', fileUrl);

    const response = await fetch(fileUrl);

    if (!response.ok) {
      log.error('[download] Fetch failed:', response.status);
      return new Response(JSON.stringify({
        error: 'Failed to fetch file',
        status: response.status
      }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' }
      });
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

  } catch (error) {
    log.error('[download] Error:', error);
    return new Response(JSON.stringify({
      error: 'Download failed',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};