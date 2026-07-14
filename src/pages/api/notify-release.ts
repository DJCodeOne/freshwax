// src/pages/api/notify-release.ts
// "Notify me on release" — free interest list for upcoming (pre-order)
// releases. No payment, no account needed: visitors leave an email and the
// notify-release-interest cron emails them on release day with a buy link.
// AUTH: Intentionally public (mirrors notify-restock). Rate limited.

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { addDocument, queryCollection, getDocument, deleteDocument } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';

const log = createLogger('notify-release');

const NotifyReleaseSchema = z.object({
  email: z.string().email('Invalid email address').max(320),
  releaseId: z.string().min(1, 'Release ID is required').max(200),
});

export const prerender = false;

// POST - register interest in an upcoming release
export const POST: APIRoute = async ({ request }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`notify-release:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const body = await request.json();
    const parsed = NotifyReleaseSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { email, releaseId } = parsed.data;

    // Release must exist and still be upcoming
    const release = await getDocument('releases', releaseId);
    if (!release) {
      return ApiErrors.notFound('Release not found');
    }
    const releaseDate = release.releaseDate ? new Date(String(release.releaseDate)) : null;
    if (!releaseDate || isNaN(releaseDate.getTime()) || releaseDate.getTime() <= Date.now()) {
      return successResponse({ alreadyReleased: true, message: 'This release is already out — you can grab it now' });
    }

    // Dedupe (equality-only query — no composite index needed)
    const existing = await queryCollection('releaseInterest', {
      filters: [
        { field: 'email', op: 'EQUAL', value: email.toLowerCase() },
        { field: 'releaseId', op: 'EQUAL', value: releaseId },
      ],
      limit: 1,
      skipCache: true,
    });

    if (existing.length > 0) {
      return successResponse({ message: 'Already on the list — we will email you on release day' });
    }

    await addDocument('releaseInterest', {
      email: email.toLowerCase(),
      releaseId,
      releaseName: String(release.releaseName || release.title || ''),
      artistName: String(release.artistName || release.artist || ''),
      releaseDate: releaseDate.toISOString(),
      status: 'active',
      createdAt: new Date().toISOString(),
    });

    log.info('[notify-release] Registered interest:', releaseId);
    return successResponse({ message: 'Sorted — we will email you the moment it drops' });
  } catch (error: unknown) {
    log.error('[notify-release] Error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Failed to set the reminder');
  }
};

// DELETE - remove interest (unsubscribe link support)
export const DELETE: APIRoute = async ({ request }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`notify-release-delete:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const url = new URL(request.url);
  const parsed = NotifyReleaseSchema.safeParse({
    email: url.searchParams.get('email') ?? '',
    releaseId: url.searchParams.get('releaseId') ?? '',
  });
  if (!parsed.success) {
    return ApiErrors.badRequest('Invalid request');
  }
  const { email, releaseId } = parsed.data;

  try {
    const subs = await queryCollection('releaseInterest', {
      filters: [
        { field: 'email', op: 'EQUAL', value: email.toLowerCase() },
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
