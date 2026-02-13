// src/pages/api/download-mix.ts
import type { APIRoute } from 'astro';
import { verifyRequestUser, initFirebaseEnv } from '../../lib/firebase-rest';

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
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  // SECURITY: Require authentication
  const { userId, error: authError } = await verifyRequestUser(request);
  if (!userId || authError) {
    return new Response(JSON.stringify({ error: 'Authentication required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const url = new URL(request.url);
  const audioUrl = url.searchParams.get('url');
  // SECURITY: Sanitize filename to prevent CRLF header injection
  const rawFilename = url.searchParams.get('filename') || 'download.mp3';
  const filename = rawFilename.replace(/[^a-zA-Z0-9._\-() ]/g, '_').slice(0, 200);

  if (!audioUrl) {
    return new Response(JSON.stringify({ error: 'Missing audio URL' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // SECURITY: Validate URL is from allowed domains only, https required
  let isAllowed = false;
  try {
    const parsedUrl = new URL(audioUrl);
    if (parsedUrl.protocol !== 'https:') {
      return new Response(JSON.stringify({ error: 'Only HTTPS URLs allowed' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    isAllowed = ALLOWED_DOMAINS.some(domain => parsedUrl.hostname === domain || parsedUrl.hostname.endsWith('.' + domain));
  } catch {
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

  } catch (error) {
    log.error('[download-mix] Error:', error);
    return new Response('Failed to download file', { status: 500 });
  }
};