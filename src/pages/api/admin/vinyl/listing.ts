import type { APIRoute } from 'astro';
import { getDocument, updateDocument } from '../../../../lib/firebase-rest';
import { requireAdminAuth, initAdminEnv } from '../../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../../lib/rate-limit';
import { ApiErrors, createLogger } from '../../../../lib/api-utils';

const log = createLogger('admin/vinyl/listing');

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`vinyl-listing:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);
  // SECURITY: Require admin authentication for viewing listing admin data
  const env = locals.runtime.env;
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });

  const authError = await requireAdminAuth(request, locals);
  if (authError) {
    return authError;
  }

  const url = new URL(request.url);
  const listingId = url.searchParams.get('id');

  if (!listingId) {
    return ApiErrors.badRequest('Listing ID required');
  }

  try {
    const listing = await getDocument('vinylListings', listingId);

    if (!listing) {
      return ApiErrors.notFound('Listing not found');
    }

    return new Response(JSON.stringify({ success: true, listing }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to fetch listing');
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`vinyl-listing-write:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);
  // SECURITY: Require admin authentication for listing management
  const env = locals.runtime.env;
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });

  const authError = await requireAdminAuth(request, locals);
  if (authError) {
    return authError;
  }

  try {
    const body = await request.json();
    const { action, listingId } = body;

    if (!listingId) {
      return ApiErrors.badRequest('Listing ID required');
    }

    const listing = await getDocument('vinylListings', listingId);
    if (!listing) {
      return ApiErrors.notFound('Listing not found');
    }

    switch (action) {
      case 'update': {
        const updateData: Record<string, unknown> = { updatedAt: new Date().toISOString() };

        const fields = [
          'artist', 'title', 'label', 'catalogNumber', 'format', 'releaseYear',
          'genre', 'mediaCondition', 'sleeveCondition', 'conditionNotes',
          'price', 'shippingCost', 'status', 'description', 'featured'
        ];

        fields.forEach(field => {
          if (body[field] !== undefined) {
            updateData[field] = body[field];
          }
        });

        await updateDocument('vinylListings', listingId, updateData);

        return new Response(JSON.stringify({ success: true, message: 'Listing updated' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      case 'approve': {
        await updateDocument('vinylListings', listingId, {
          status: 'published',
          approvedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });

        return new Response(JSON.stringify({ success: true, message: 'Listing approved' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      case 'remove': {
        const { reason } = body;

        await updateDocument('vinylListings', listingId, {
          status: 'removed',
          removedAt: new Date().toISOString(),
          removedReason: reason || 'Removed by admin',
          updatedAt: new Date().toISOString()
        });

        return new Response(JSON.stringify({ success: true, message: 'Listing removed' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      case 'delete': {
        await updateDocument('vinylListings', listingId, {
          deleted: true,
          deletedAt: new Date().toISOString(),
          status: 'removed',
          updatedAt: new Date().toISOString()
        });

        return new Response(JSON.stringify({ success: true, message: 'Listing deleted' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      default:
        return ApiErrors.badRequest('Invalid action');
    }
  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Server error');
  }
};
