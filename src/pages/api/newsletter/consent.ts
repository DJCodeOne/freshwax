// src/pages/api/newsletter/consent.ts
// Records a marketing opt-in ticked by a logged-in user (currently: checkout).
//
// AUTH: login required. The address comes from the verified session and is
// NEVER read from the body — same rule as notify-release.ts. Otherwise anyone
// could subscribe an address they don't own, which is exactly the abuse the
// double opt-in on the public footer form exists to prevent.
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { verifyRequestUser } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';
import { recordMarketingConsent } from '../../../lib/newsletter-consent';

const log = createLogger('newsletter/consent');

const ConsentSchema = z.object({
  source: z.enum(['checkout', 'account']).default('checkout'),
  name: z.string().max(100).optional(),
});

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`newsletter-consent:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const { userId, email, error: authError } = await verifyRequestUser(request);
  if (!userId || authError || !email) {
    return ApiErrors.unauthorized('Authentication required');
  }

  try {
    const body = await request.json().catch(() => ({}));
    const parsed = ConsentSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const recorded = await recordMarketingConsent({
      email,
      name: parsed.data.name,
      source: parsed.data.source,
      ip: clientId,
    });

    return successResponse({ subscribed: recorded });
  } catch (error: unknown) {
    log.error('Consent error:', error);
    return ApiErrors.serverError('Failed to record preference');
  }
};
