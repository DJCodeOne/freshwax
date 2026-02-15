// src/pages/api/check-admin.ts
// Lightweight endpoint to check if the current user is an admin
// Used by client-side scripts to avoid hardcoding admin emails/UIDs

import type { APIRoute } from 'astro';
import { verifyUserToken, initFirebaseEnv } from '../../lib/firebase-rest';
import { isAdmin } from '../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit: auth tier (strict) - 10 per 15 minutes to prevent user enumeration
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`check-admin:${clientId}`, RateLimiters.auth);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const runtime = locals.runtime;
  if (runtime?.env) {
    initFirebaseEnv(runtime.env);
  }

  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return new Response(JSON.stringify({ isAdmin: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }

  try {
    const userId = await verifyUserToken(token);
    if (!userId) {
      return new Response(JSON.stringify({ isAdmin: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    }

    const adminStatus = await isAdmin(userId);
    return new Response(JSON.stringify({ isAdmin: adminStatus }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  } catch {
    return new Response(JSON.stringify({ isAdmin: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }
};
