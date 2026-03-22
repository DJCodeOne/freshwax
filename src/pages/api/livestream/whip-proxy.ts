// src/pages/api/livestream/whip-proxy.ts
// WHIP signaling proxy — same-origin relay to avoid CORS with stream.freshwax.co.uk
// POST ?key={streamKey}: Proxy SDP offer to MediaMTX, return SDP answer
// DELETE ?resource={url}: Proxy DELETE to MediaMTX resource URL
// AUTH: Stream key IS the authentication — POST validates the stream key against
// active livestream slots before proxying. DELETE validates the resource URL points
// to our WHIP server (domain whitelist).
import type { APIRoute } from 'astro';
import { ApiErrors, createLogger, fetchWithTimeout } from '../../../lib/api-utils';
import { TIMEOUTS } from '../../../lib/timeouts';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { queryCollection } from '../../../lib/firebase-rest';

const log = createLogger('livestream/whip-proxy');

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`whip-proxy:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const url = new URL(request.url);
    const streamKey = url.searchParams.get('key');
    if (!streamKey) {
      return ApiErrors.badRequest('Stream key required');
    }

    // Validate that stream key maps to a valid, current slot
    try {
      const slots = await queryCollection('livestreamSlots', {
        filters: [{ field: 'streamKey', op: 'EQUAL', value: streamKey }],
        limit: 1
      });
      if (slots.length === 0) {
        log.warn('WHIP proxy: no slot found for stream key');
        return ApiErrors.forbidden('Invalid stream key');
      }
      const slot = slots[0];
      // Only allow keys for slots that are active (in_lobby, live, scheduled within 15min)
      const validStatuses = ['scheduled', 'in_lobby', 'live', 'queued'];
      if (!validStatuses.includes(slot.status as string)) {
        log.warn('WHIP proxy: slot status not valid for streaming:', slot.status);
        return ApiErrors.forbidden('Stream slot is not active');
      }
      // Reject if slot endTime has passed
      if (slot.endTime && new Date(slot.endTime as string) < new Date()) {
        log.warn('WHIP proxy: slot has expired');
        return ApiErrors.forbidden('Stream slot has expired');
      }
    } catch (validationErr: unknown) {
      // Fail closed — deny streaming if validation query fails
      log.error('WHIP proxy: slot validation failed, denying:', validationErr instanceof Error ? validationErr.message : String(validationErr));
      return ApiErrors.serverError('Stream validation unavailable');
    }

    const whipBaseUrl = (locals as App.Locals).runtime?.env?.WHIP_BASE_URL || import.meta.env.WHIP_BASE_URL;
    if (!whipBaseUrl) {
      return ApiErrors.serverError('WHIP not configured');
    }

    const targetUrl = `${whipBaseUrl.replace(/\/$/, '')}/live/${encodeURIComponent(streamKey)}/whip`;

    // Read SDP offer from request body
    const sdpOffer = await request.text();
    if (!sdpOffer) {
      return ApiErrors.badRequest('SDP offer required');
    }

    // Forward to MediaMTX
    const mtxResponse = await fetchWithTimeout(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: sdpOffer,
    }, TIMEOUTS.API);

    if (!mtxResponse.ok) {
      const errText = await mtxResponse.text().catch(() => '');
      log.error('MediaMTX WHIP error:', mtxResponse.status, errText);
      return new Response(errText || 'WHIP server error', { status: mtxResponse.status });
    }

    const sdpAnswer = await mtxResponse.text();

    // Rewrite Location header to go through our proxy
    const headers: Record<string, string> = {
      'Content-Type': 'application/sdp',
    };

    const location = mtxResponse.headers.get('Location');
    if (location) {
      // Encode the original resource URL so DELETE goes through our proxy too
      const proxyLocation = `/api/livestream/whip-proxy/?resource=${encodeURIComponent(location)}`;
      headers['Location'] = proxyLocation;
    }

    return new Response(sdpAnswer, { status: 201, headers });

  } catch (error: unknown) {
    log.error('WHIP proxy POST error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('WHIP proxy failed');
  }
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`whip-proxy-del:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const url = new URL(request.url);
    const resourceUrl = url.searchParams.get('resource');
    if (!resourceUrl) {
      return ApiErrors.badRequest('Resource URL required');
    }

    // Validate the resource URL points to our WHIP server
    const whipBaseUrl = (locals as App.Locals).runtime?.env?.WHIP_BASE_URL || import.meta.env.WHIP_BASE_URL;
    if (whipBaseUrl && !resourceUrl.startsWith(whipBaseUrl.replace(/\/$/, ''))) {
      return ApiErrors.forbidden('Invalid resource URL');
    }

    // Forward DELETE to MediaMTX
    await fetchWithTimeout(resourceUrl, { method: 'DELETE' }, TIMEOUTS.SHORT).catch(() => {
      // Best effort — stream may already be gone
    });

    return new Response(null, { status: 200 });

  } catch (error: unknown) {
    log.error('WHIP proxy DELETE error:', error instanceof Error ? error.message : String(error));
    return new Response(null, { status: 200 }); // Don't fail on cleanup
  }
};
