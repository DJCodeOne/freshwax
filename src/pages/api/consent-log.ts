// src/pages/api/consent-log.ts
// GDPR compliance: Server-side audit trail for cookie consent decisions
// Logs consent choices with timestamp, IP, and categories to Firestore
// AUTH: Intentionally public — GDPR consent must be logged for all visitors,
// including unauthenticated users. Rate limited to 5/min.

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { addDocument } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse, errorResponse } from '../../lib/api-utils';

const log = createLogger('consent-log');

const ConsentLogSchema = z.object({
  necessary: z.boolean().optional(),
  analytics: z.boolean(),
  marketing: z.boolean(),
  action: z.enum(['accept_all', 'reject_all', 'save']).optional().default('save'),
});

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Tight rate limit: consent changes are rare — 5 per minute per client
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`consent-log:${clientId}`, {
    maxRequests: 5,
    windowMs: 60_000,
    blockDurationMs: 60_000,
  });
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  try {
    const body = await request.json();
    const parsed = ConsentLogSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid consent data');
    }
    const { analytics, marketing, action } = parsed.data;

    await addDocument('consentLogs', {
      necessary: true,
      analytics: !!analytics,
      marketing: !!marketing,
      action: action || 'save', // 'accept_all', 'reject_all', 'save'
      ip: clientId,
      userAgent: request.headers.get('user-agent') || '',
      timestamp: new Date().toISOString()
    });

    return successResponse({} as Record<string, unknown>);
  } catch (error: unknown) {
    log.error('[consent-log] Error:', error);
    return errorResponse('Failed to log consent', 500);
  }
};
