// src/pages/api/admin/server-status.ts
// Check MediaMTX server status
import type { APIRoute } from 'astro';

export const GET: APIRoute = async () => {
  try {
    // Try to reach the MediaMTX API
    const streamServerUrl = 'https://stream.freshwax.co.uk';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(`${streamServerUrl}/v3/config/global/get`, {
        method: 'GET',
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (response.ok) {
        return new Response(JSON.stringify({
          online: true,
          status: 'running',
          url: streamServerUrl
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    } catch (fetchError) {
      clearTimeout(timeout);
    }

    // Try alternate check - just see if server responds at all
    try {
      const altResponse = await fetch(streamServerUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(3000)
      });

      if (altResponse.ok || altResponse.status === 404) {
        return new Response(JSON.stringify({
          online: true,
          status: 'running',
          url: streamServerUrl,
          note: 'API endpoint not available but server responding'
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    } catch {}

    return new Response(JSON.stringify({
      online: false,
      status: 'offline',
      url: streamServerUrl
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[ServerStatus] Error:', error);
    return new Response(JSON.stringify({
      online: false,
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
