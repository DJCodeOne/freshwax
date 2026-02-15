// src/pages/api/admin/server-status.ts
// Check MediaMTX server status
import type { APIRoute } from 'astro';

import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });

  // Rate limit
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`server-status:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  // SECURITY: Require admin authentication
  const authError = await requireAdminAuth(request, locals);
  if (authError) {
    return authError;
  }

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
      error: 'Server status check failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
