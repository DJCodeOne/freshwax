// src/pages/api/download.ts
// Server-side download proxy to bypass CORS for R2 files

import type { APIRoute } from 'astro';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
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
    'res.cloudinary.com',
    'firebasestorage.googleapis.com'
  ];
  
  let isAllowed = false;
  try {
    const parsedUrl = new URL(fileUrl);
    isAllowed = allowedDomains.some(domain => parsedUrl.hostname.includes(domain));
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
    
    const data = await response.arrayBuffer();
    
    log.info('[download] Success, size:', data.byteLength, 'bytes');
    
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': 'attachment; filename="' + encodeURIComponent(filename) + '"',
        'Content-Length': data.byteLength.toString(),
        'Cache-Control': 'private, max-age=3600'
      }
    });
    
  } catch (error) {
    log.error('[download] Error:', error);
    return new Response(JSON.stringify({ 
      error: 'Download failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};