// src/pages/api/download-mix.ts
import type { APIRoute } from 'astro';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const audioUrl = url.searchParams.get('url');
  const filename = url.searchParams.get('filename') || 'download.mp3';

  if (!audioUrl) {
    return new Response('Missing audio URL', { status: 400 });
  }

  try {
    log.info('[download-mix] Proxying download for:', audioUrl);

    const response = await fetch(audioUrl);

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