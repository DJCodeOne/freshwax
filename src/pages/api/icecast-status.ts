// src/pages/api/icecast-status.ts
// Proxy for Icecast status to avoid CORS issues

import type { APIContext } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { fetchWithTimeout } from '../../lib/api-utils';

export async function GET({ request, locals }: APIContext) {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`icecast-status:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const runtime = locals.runtime;
  const icecastUrl = runtime?.env?.ICECAST_STATUS_URL || 'https://icecast.freshwax.co.uk/status-json.xsl';

  try {
    const response = await fetchWithTimeout(icecastUrl, {
      headers: {
        'Accept': 'application/json'
      }
    }, 5000);

    if (!response.ok) {
      return new Response(JSON.stringify({
        online: false,
        error: 'Server not reachable'
      }), {
        status: 200, // Return 200 to avoid console errors
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const data = await response.json();
    const hasSource = data.icestats?.source != null;
    const title = hasSource ? (data.icestats.source.title || null) : null;

    return new Response(JSON.stringify({
      online: true,
      streaming: hasSource,
      title: title
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    // Server not running or network error - return clean response
    return new Response(JSON.stringify({
      online: false,
      error: error instanceof Error && error.name === 'AbortError' ? 'Timeout' : 'Not connected'
    }), {
      status: 200, // Return 200 to avoid console errors
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
