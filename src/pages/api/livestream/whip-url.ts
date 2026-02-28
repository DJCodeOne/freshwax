// src/pages/api/livestream/whip-url.ts
// Returns authenticated WHIP URL for browser-based streaming
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { verifyRequestUser } from '../../../lib/firebase-rest';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

const log = createLogger('livestream/whip-url');

const WhipUrlSchema = z.object({
  slotId: z.string().min(1).max(500),
  djId: z.string().min(1).max(500),
  streamKey: z.string().min(1).max(500),
});

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`whip-url:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    // Verify authentication
    const authResult = await verifyRequestUser(request);
    if (!authResult.userId) {
      return ApiErrors.unauthorized('Authentication required');
    }
    const userId = authResult.userId;

    const rawBody = await request.json();
    const parseResult = WhipUrlSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('slotId, djId, and streamKey are required');
    }
    const { slotId, djId, streamKey } = parseResult.data;

    // Verify the authenticated user matches the DJ
    if (userId !== djId) {
      return ApiErrors.forbidden('Not authorized for this DJ');
    }

    // Return proxy URL (same origin) to avoid CORS with stream.freshwax.co.uk
    // The proxy at /api/livestream/whip-proxy/ relays SDP to MediaMTX via WHIP_BASE_URL
    const whipUrl = `/api/livestream/whip-proxy/?key=${encodeURIComponent(streamKey)}`;

    return successResponse({ whipUrl });

  } catch (error: unknown) {
    log.error('Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to get WHIP URL');
  }
};
