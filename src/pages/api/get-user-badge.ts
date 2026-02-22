// src/pages/api/get-user-badge.ts
// Get user's Plus badge from KV storage (no Firebase reads)
import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger } from '../../lib/api-utils';

const log = createLogger('get-user-badge');

export const prerender = false;

// KV key for user badge
const getBadgeKey = (userId: string) => `plus-badge:${userId}`;

export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`get-user-badge:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const env = locals.runtime.env;
    const kv = env?.CACHE as KVNamespace | undefined;

    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');

    if (!userId) {
      return ApiErrors.badRequest('Missing userId');
    }

    // Try KV first (fast, no quota impact)
    let badge = 'crown'; // Default
    if (kv) {
      const stored = await kv.get(getBadgeKey(userId));
      if (stored) {
        badge = stored;
      }
    }

    return successResponse({ badge });

  } catch (error: unknown) {
    log.error('[get-user-badge] Error:', error);
    // Default to crown on error
    return successResponse({ badge: 'crown' });
  }
};
