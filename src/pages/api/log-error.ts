// src/pages/api/log-error.ts
// Receives client-side error reports and stores in D1

import type { APIRoute } from 'astro';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../lib/rate-limit';
import { logError } from '../../lib/error-logger';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Tight rate limit: 10 errors per minute per client
  const clientId = getClientId(request);
  const rl = checkRateLimit(`log-error:${clientId}`, {
    maxRequests: 10,
    windowMs: 60_000,
    blockDurationMs: 60_000,
  });
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter!);

  try {
    const body = await request.json();
    const { message, stack, url, level, metadata } = body;

    if (!message || typeof message !== 'string') {
      return new Response(JSON.stringify({ success: false, error: 'Missing message' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const env = locals.runtime.env;

    await logError({
      source: 'client',
      level: level === 'warn' ? 'warn' : level === 'fatal' ? 'fatal' : 'error',
      message: String(message).slice(0, 2000),
      stack: stack ? String(stack).slice(0, 5000) : undefined,
      url: url ? String(url).slice(0, 500) : undefined,
      userAgent: request.headers.get('User-Agent') || undefined,
      ip: request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || undefined,
      metadata: metadata && typeof metadata === 'object' ? metadata : undefined,
    }, env);

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return new Response(JSON.stringify({ success: false }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
