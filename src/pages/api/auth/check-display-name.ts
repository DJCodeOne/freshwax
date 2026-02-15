// src/pages/api/auth/check-display-name.ts
// Check if a display name is available (used by registration form)
// Replaces client-side Firestore query (~200KB SDK saved)

import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { queryCollection } from '../../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  // Rate limit: auth tier (strict) - 10 per 15 minutes to prevent user enumeration
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`check-name:${clientId}`, RateLimiters.auth);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const url = new URL(request.url);
  const name = url.searchParams.get('name');

  if (!name || name.trim().length < 2) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Display name must be at least 2 characters'
    }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const normalizedName = name.trim().toLowerCase();

    const results = await queryCollection('users', {
      filters: [{ field: 'displayNameLower', op: 'EQUAL', value: normalizedName }],
      limit: 1,
      skipCache: true
    });

    const isTaken = results.length > 0;

    return new Response(JSON.stringify({
      success: true,
      available: !isTaken,
      name: name.trim()
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      }
    });
  } catch (error: any) {
    console.error('[check-display-name] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to check display name'
    }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
};
