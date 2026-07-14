// src/pages/api/notify-release.ts
// "Notify me on release" — free interest list for upcoming (pre-order)
// releases. No payment, but a Fresh Wax account IS required: the signup is
// one click and the email comes from the verified session, never from the
// request body. The notify-release-interest cron emails the list on
// release day with a buy link.

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { addDocument, queryCollection, getDocument, deleteDocument, verifyRequestUser } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';

const log = createLogger('notify-release');

const NotifyReleaseSchema = z.object({
  releaseId: z.string().min(1, 'Release ID is required').max(200),
});

export const prerender = false;

// POST - register interest in an upcoming release (account required)
export const POST: APIRoute = async ({ request }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`notify-release:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const { userId, email, error: authError } = await verifyRequestUser(request);
  if (authError || !userId) {
    return ApiErrors.unauthorized(authError || 'Sign in to set a release reminder');
  }
  if (!email || !email.includes('@')) {
    return ApiErrors.badRequest('Your account has no email address');
  }

  try {
    const body = await request.json();
    const parsed = NotifyReleaseSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { releaseId } = parsed.data;

    // Release must exist and still be upcoming
    const release = await getDocument('releases', releaseId);
    if (!release) {
      return ApiErrors.notFound('Release not found');
    }
    const releaseDate = release.releaseDate ? new Date(String(release.releaseDate)) : null;
    if (!releaseDate || isNaN(releaseDate.getTime()) || releaseDate.getTime() <= Date.now()) {
      return successResponse({ alreadyReleased: true, message: 'This release is already out — you can grab it now' });
    }

    // Dedupe per user+release (equality-only query — no composite index needed)
    const existing = await queryCollection('releaseInterest', {
      filters: [
        { field: 'userId', op: 'EQUAL', value: userId },
        { field: 'releaseId', op: 'EQUAL', value: releaseId },
      ],
      limit: 1,
      skipCache: true,
    });

    if (existing.length > 0) {
      return successResponse({ message: "Already on the list — we'll email you on release day" });
    }

    await addDocument('releaseInterest', {
      userId,
      email: email.toLowerCase(),
      releaseId,
      releaseName: String(release.releaseName || release.title || ''),
      artistName: String(release.artistName || release.artist || ''),
      releaseDate: releaseDate.toISOString(),
      status: 'active',
      createdAt: new Date().toISOString(),
    });

    log.info('[notify-release] Registered interest:', releaseId);
    return successResponse({ message: "Sorted — we'll email you the moment it drops" });
  } catch (error: unknown) {
    log.error('[notify-release] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to set the reminder');
  }
};

// DELETE - remove the caller's own reminder for a release
export const DELETE: APIRoute = async ({ request }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`notify-release-delete:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const { userId, error: authError } = await verifyRequestUser(request);
  if (authError || !userId) {
    return ApiErrors.unauthorized(authError || 'Authentication required');
  }

  const url = new URL(request.url);
  const parsed = NotifyReleaseSchema.safeParse({
    releaseId: url.searchParams.get('releaseId') ?? '',
  });
  if (!parsed.success) {
    return ApiErrors.badRequest('Invalid request');
  }
  const { releaseId } = parsed.data;

  try {
    const subs = await queryCollection('releaseInterest', {
      filters: [
        { field: 'userId', op: 'EQUAL', value: userId },
        { field: 'releaseId', op: 'EQUAL', value: releaseId },
      ],
      limit: 10,
      skipCache: true,
    });
    for (const sub of subs) {
      await deleteDocument('releaseInterest', String(sub.id));
    }
    return successResponse({ message: 'Reminder removed' });
  } catch (error: unknown) {
    log.error('[notify-release] DELETE error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to remove the reminder');
  }
};
