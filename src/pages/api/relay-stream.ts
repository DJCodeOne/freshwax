// src/pages/api/relay-stream.ts
// Proxy audio streams to solve mixed content (HTTP->HTTPS) issues

import type { APIRoute } from 'astro';
import { getStationById } from '../../lib/relay-stations';

export const GET: APIRoute = async ({ url }) => {
  const stationId = url.searchParams.get('station');
  const testMode = url.searchParams.get('test') === '1';

  if (!stationId) {
    return new Response(JSON.stringify({ error: 'Missing station parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const station = getStationById(stationId);
  if (!station) {
    return new Response(JSON.stringify({ error: 'Unknown station', stationId }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Create abort controller with timeout for initial connection
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    // Fetch the audio stream
    const response = await fetch(station.streamUrl, {
      headers: {
        'User-Agent': 'FreshWax/1.0 (Audio Relay)',
        'Icy-MetaData': '0'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    // Test mode - just return info about the connection
    if (testMode) {
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return new Response(JSON.stringify({
        success: true,
        status: response.status,
        statusText: response.statusText,
        headers,
        url: station.streamUrl
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!response.ok) {
      return new Response(JSON.stringify({
        error: 'Stream unavailable',
        status: response.status,
        statusText: response.statusText,
        url: station.streamUrl
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get content type from upstream or default to audio/mpeg
    const contentType = response.headers.get('content-type') || 'audio/mpeg';

    // Build response headers for streaming
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
      'X-Relay-Station': station.name
    };

    // Pass through icy headers
    const icyHeaders = ['icy-name', 'icy-genre', 'icy-br', 'icy-sr'];
    for (const header of icyHeaders) {
      const value = response.headers.get(header);
      if (value) {
        headers[header] = value;
      }
    }

    // Stream the response body directly
    return new Response(response.body, {
      status: 200,
      headers
    });

  } catch (err: any) {
    console.error('Relay stream error:', err);
    const errorDetails = {
      error: 'Stream connection failed',
      message: err.message,
      name: err.name,
      url: station.streamUrl
    };
    return new Response(JSON.stringify(errorDetails), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
