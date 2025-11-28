// src/pages/api/download-mix.ts
import type { APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const audioUrl = url.searchParams.get('url');
  const filename = url.searchParams.get('filename') || 'download.mp3';

  if (!audioUrl) {
    return new Response('Missing audio URL', { status: 400 });
  }

  try {
    console.log('[DOWNLOAD-MIX] Proxying download for:', audioUrl);
    
    // Fetch the file from the CDN
    const response = await fetch(audioUrl);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch: ${response.status}`);
    }

    // Get the audio data
    const audioData = await response.arrayBuffer();
    
    console.log('[DOWNLOAD-MIX] ✓ Successfully fetched', audioData.byteLength, 'bytes');

    // Return the file with proper headers to force download
    return new Response(audioData, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': audioData.byteLength.toString(),
        'Cache-Control': 'no-cache'
      }
    });

  } catch (error) {
    console.error('[DOWNLOAD-MIX] Error:', error);
    return new Response('Failed to download file', { status: 500 });
  }
};