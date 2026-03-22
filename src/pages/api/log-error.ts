// src/pages/api/log-error.ts
// Receives client-side error reports and stores in D1
// AUTH: Intentionally public — client-side error logging must work for all visitors,
// including unauthenticated users. Rate limited to 10/min.

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../lib/rate-limit';
import { logError } from '../../lib/error-logger';
import { ApiErrors, successResponse, errorResponse } from '../../lib/api-utils';

const LogErrorSchema = z.object({
  message: z.string().min(1, 'Missing message').max(2000),
  stack: z.string().max(5000).optional(),
  url: z.string().max(500).optional(),
  level: z.enum(['error', 'warn', 'fatal']).optional().default('error'),
  metadata: z.record(z.unknown()).optional(),
});

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
    const parsed = LogErrorSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { message, stack, url, level, metadata } = parsed.data;

    const env = locals.runtime.env;

    await logError({
      source: 'client',
      level,
      message,
      stack: stack || undefined,
      url: url || undefined,
      userAgent: request.headers.get('User-Agent') || undefined,
      ip: request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || undefined,
      metadata: metadata && typeof metadata === 'object' ? metadata : undefined,
    }, env);

    return successResponse({} as Record<string, unknown>);
  } catch (e: unknown) {
    return errorResponse('Failed to log error', 500);
  }
};
