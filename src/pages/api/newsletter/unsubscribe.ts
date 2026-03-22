// src/pages/api/newsletter/unsubscribe.ts
// AUTH: Intentionally public — unsubscribe must work from email links without login.
// Returns success even for non-existent emails to prevent email enumeration.
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { queryCollection, updateDocument } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('newsletter/unsubscribe');

const UnsubscribeSchema = z.object({
  email: z.string().email('Invalid email format').max(320),
});

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: 60 per minute to prevent abuse
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`newsletter-unsubscribe:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;

  try {
    const body = await request.json();
    const parsed = UnsubscribeSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { email } = parsed.data;

    const normalizedEmail = email.toLowerCase().trim();

    // Find subscriber
    const subscribers = await queryCollection('subscribers', {
      filters: [{ field: 'email', op: 'EQUAL', value: normalizedEmail }],
      limit: 1
    });

    if (subscribers.length === 0) {
      // Email not found - still return success to avoid email enumeration
      return successResponse({ message: 'If this email was subscribed, it has been unsubscribed.' });
    }

    const subscriberDoc = subscribers[0];

    // Update status to unsubscribed
    await updateDocument('subscribers', subscriberDoc.id, {
      status: 'unsubscribed',
      unsubscribedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    return successResponse({ message: 'Successfully unsubscribed from newsletter' });

  } catch (error: unknown) {
    log.error('Unsubscribe error:', error);
    return ApiErrors.serverError('Failed to unsubscribe. Please try again.');
  }
};
