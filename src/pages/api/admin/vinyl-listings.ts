// src/pages/api/admin/vinyl-listings.ts
// Admin API for managing vinyl listing approvals

import type { APIRoute } from 'astro';

import { saQueryCollection, saUpdateDocument, saGetDocument, getServiceAccountKey } from '../../../lib/firebase-service-account';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../../lib/rate-limit';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('[vinyl-listings]');

export const prerender = false;

// GET - Fetch pending vinyl listings for admin review
export const GET: APIRoute = async ({ request, locals }) => {  const env = locals.runtime.env || {};

  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`admin-vinyl-read:${clientId}`, {
    maxRequests: 60,
    windowMs: 60 * 1000
  });

  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const serviceAccountKey = getServiceAccountKey(env);
    const projectId = env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      return ApiErrors.serverError('Service account not configured');
    }

    // Query pending vinyl listings
    const listings = await saQueryCollection(serviceAccountKey, projectId, 'vinylListings', {
      filters: [
        { field: 'status', op: 'EQUAL', value: 'pending' }
      ],
      orderBy: { field: 'submittedAt', direction: 'DESCENDING' },
      limit: 50
    });

    log.info('[admin/vinyl-listings GET] Found', listings.length, 'pending listings');

    return successResponse({ listings: listings || [],
      count: listings.length });

  } catch (error: unknown) {
    log.error('[admin/vinyl-listings GET] Error:', error);
    return ApiErrors.serverError('Failed to fetch listings');
  }
};

// POST - Approve or reject vinyl listing
export const POST: APIRoute = async ({ request, locals }) => {  const env = locals.runtime.env || {};

  // Rate limit writes
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`admin-vinyl-write:${clientId}`, {
    maxRequests: 30,
    windowMs: 60 * 60 * 1000
  });

  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const body = await request.json();
    initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const { action, listingId } = body;

    if (!listingId) {
      return ApiErrors.badRequest('Listing ID required');
    }

    if (!['approve', 'reject'].includes(action)) {
      return ApiErrors.badRequest('Invalid action (approve or reject)');
    }

    const serviceAccountKey = getServiceAccountKey(env);
    const projectId = env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      return ApiErrors.serverError('Service account not configured');
    }

    // Get the listing first
    const listing = await saGetDocument(serviceAccountKey, projectId, 'vinylListings', listingId);
    if (!listing) {
      return ApiErrors.notFound('Listing not found');
    }

    const now = new Date().toISOString();
    let updateData: Record<string, unknown>;

    if (action === 'approve') {
      updateData = {
        status: 'published',
        approvedAt: now,
        updatedAt: now
      };
      log.info('[admin/vinyl-listings POST] Approved listing:', listingId);
    } else {
      updateData = {
        status: 'rejected',
        rejectedAt: now,
        updatedAt: now
      };
      log.info('[admin/vinyl-listings POST] Rejected listing:', listingId);
    }

    await saUpdateDocument(serviceAccountKey, projectId, 'vinylListings', listingId, updateData);

    return successResponse({ message: `Listing ${action === 'approve' ? 'approved' : 'rejected'}`,
      listingId });

  } catch (error: unknown) {
    log.error('[admin/vinyl-listings POST] Error:', error);
    return ApiErrors.serverError('Server error');
  }
};
