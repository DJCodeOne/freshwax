import type { APIRoute } from 'astro';
import { getDocument, updateDocument } from '@lib/firebase-rest';
import { requireAdminAuth, initAdminEnv } from '@lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '@lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '@lib/api-utils';
import { z } from 'zod';

const log = createLogger('admin/vinyl/listing');

const vinylListingSchema = z.object({
  action: z.enum(['update', 'approve', 'remove', 'delete']),
  listingId: z.string().min(1),
  artist: z.string().optional(),
  title: z.string().optional(),
  label: z.string().optional(),
  catalogNumber: z.string().optional(),
  format: z.string().optional(),
  releaseYear: z.union([z.string(), z.number()]).optional(),
  genre: z.string().optional(),
  mediaCondition: z.string().optional(),
  sleeveCondition: z.string().optional(),
  conditionNotes: z.string().optional(),
  price: z.number().optional(),
  shippingCost: z.number().optional(),
  status: z.string().optional(),
  description: z.string().optional(),
  featured: z.boolean().optional(),
  reason: z.string().optional(),
});

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

    return successResponse({ listing });
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
    const parsed = vinylListingSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request: action and listingId required');
    }

    const { action, listingId } = parsed.data;

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
          const val = (parsed.data as Record<string, unknown>)[field];
          if (val !== undefined) {
            updateData[field] = val;
          }
        });

        await updateDocument('vinylListings', listingId, updateData);

        return successResponse({ message: 'Listing updated' });
      }

      case 'approve': {
        await updateDocument('vinylListings', listingId, {
          status: 'published',
          approvedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });

        return successResponse({ message: 'Listing approved' });
      }

      case 'remove': {
        const { reason } = parsed.data;

        await updateDocument('vinylListings', listingId, {
          status: 'removed',
          removedAt: new Date().toISOString(),
          removedReason: reason || 'Removed by admin',
          updatedAt: new Date().toISOString()
        });

        return successResponse({ message: 'Listing removed' });
      }

      case 'delete': {
        await updateDocument('vinylListings', listingId, {
          deleted: true,
          deletedAt: new Date().toISOString(),
          status: 'removed',
          updatedAt: new Date().toISOString()
        });

        return successResponse({ message: 'Listing deleted' });
      }

      default:
        return ApiErrors.badRequest('Invalid action');
    }
  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Server error');
  }
};
