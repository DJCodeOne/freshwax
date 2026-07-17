// src/pages/api/newsletter/one-click.ts
// RFC 8058 one-click unsubscribe target for marketing email.
//
// AUTH: Intentionally public — authorised by the per-recipient HMAC token in
// the link, not by a session. Gmail and Yahoo have required this of bulk
// senders since Feb 2024; without it, marketing mail lands in spam.
//
// POST-only BY DESIGN. Mailbox security scanners and link prefetchers issue
// GETs against every URL in an email — if GET unsubscribed, they would quietly
// unsubscribe recipients who never clicked. Humans reach the confirm button on
// /unsubscribe/ instead; only mail clients POST here.
import type { APIRoute } from 'astro';
import { queryCollection, updateDocument } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';
import { normalizeEmail, verifyUnsubscribeToken } from '../../../lib/newsletter-tokens';

const log = createLogger('newsletter/one-click');

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`newsletter-one-click:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;

  try {
    const url = new URL(request.url);
    const email = normalizeEmail(url.searchParams.get('e') || '');
    const token = url.searchParams.get('t') || '';

    if (!email || !token) {
      return ApiErrors.badRequest('Invalid unsubscribe link');
    }

    if (!(await verifyUnsubscribeToken(env, email, token))) {
      log.warn('Rejected unsubscribe with bad token');
      return ApiErrors.badRequest('Invalid unsubscribe link');
    }

    const subscribers = await queryCollection('subscribers', {
      filters: [{ field: 'email', op: 'EQUAL', value: email }],
      limit: 1,
    });

    // Already gone, or never here: report success either way. The token proves
    // the caller holds the address, so this leaks nothing — but a mail client
    // that sees a failure may retry or surface an error to the recipient.
    if (subscribers.length === 0) {
      return successResponse({ message: 'You have been unsubscribed.' });
    }

    const subscriber = subscribers[0] as Record<string, unknown>;
    if (subscriber.status !== 'unsubscribed') {
      await updateDocument('subscribers', String(subscriber.id), {
        status: 'unsubscribed',
        unsubscribedAt: new Date().toISOString(),
        unsubscribeSource: 'one-click',
        updatedAt: new Date().toISOString(),
      });
      log.info('One-click unsubscribe processed');
    }

    return successResponse({ message: 'You have been unsubscribed.' });
  } catch (error: unknown) {
    log.error('One-click unsubscribe error:', error);
    return ApiErrors.serverError('Failed to unsubscribe. Please try again.');
  }
};
