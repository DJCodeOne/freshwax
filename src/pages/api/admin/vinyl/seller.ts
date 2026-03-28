import type { APIRoute } from 'astro';
import { getDocument, updateDocument, queryCollection } from '@lib/firebase-rest';
import { requireAdminAuth, initAdminEnv } from '@lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '@lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '@lib/api-utils';
import { z } from 'zod';

const log = createLogger('admin/vinyl/seller');

const vinylSellerSchema = z.object({
  action: z.enum(['update', 'suspend', 'unsuspend', 'delete']),
  sellerId: z.string().min(1),
  source: z.string().optional(),
  storeName: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  discogsUrl: z.string().optional(),
  approved: z.boolean().optional(),
  suspended: z.boolean().optional(),
});

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`vinyl-seller:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);  const env = locals?.runtime?.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });

  // Verify admin authentication for GET as well (sensitive seller data)
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const url = new URL(request.url);
  const sellerId = url.searchParams.get('id');

  if (!sellerId) {
    return ApiErrors.badRequest('Seller ID required');
  }

  try {
    // First try vinylSellers collection (legacy)
    let seller = await getDocument('vinylSellers', sellerId);
    let source = 'vinylSellers';

    // If not found, try users collection (new system)
    if (!seller) {
      const user = await getDocument('users', sellerId);
      if (user && user.roles?.vinylSeller === true) {
        seller = {
          id: user.id,
          storeName: user.partnerInfo?.storeName || user.partnerInfo?.displayName || user.displayName || 'Unnamed Store',
          email: user.email,
          location: user.partnerInfo?.location || user.address?.city || '',
          approved: user.approved === true || user.partnerInfo?.approved === true ||
                    user.pendingRoles?.vinylSeller?.status === 'approved',
          suspended: user.suspended === true || user.disabled === true,
          discogsUrl: user.partnerInfo?.discogsUrl || '',
          description: user.partnerInfo?.description || '',
          createdAt: user.createdAt,
          userId: user.id
        };
        source = 'users';
      }
    }

    if (!seller) {
      return ApiErrors.notFound('Seller not found');
    }

    return successResponse({ seller, source });
  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to fetch seller');
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`vinyl-seller-write:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);  const env = locals?.runtime?.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });

  try {
    const body = await request.json();

    // Verify admin authentication
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const parsed = vinylSellerSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request: action and sellerId required');
    }

    const { action, sellerId, source } = parsed.data;

    // Determine collection - check if seller exists in vinylSellers or users
    let seller = await getDocument('vinylSellers', sellerId);
    let collection = 'vinylSellers';

    if (!seller) {
      const user = await getDocument('users', sellerId);
      if (user && user.roles?.vinylSeller === true) {
        seller = user;
        collection = 'users';
      }
    }

    if (!seller) {
      return ApiErrors.notFound('Seller not found');
    }

    switch (action) {
      case 'update': {
        const { storeName, description, location, discogsUrl, approved, suspended } = parsed.data;

        if (collection === 'users') {
          // Update user document
          const updateData: Record<string, unknown> = {
            updatedAt: new Date().toISOString(),
            'partnerInfo.storeName': storeName,
            'partnerInfo.description': description,
            'partnerInfo.location': location,
            'partnerInfo.discogsUrl': discogsUrl
          };
          if (approved !== undefined) updateData.approved = approved;
          if (suspended !== undefined) updateData.suspended = suspended;
          if (approved !== undefined || suspended !== undefined) {
            updateData['roles.vinylSeller'] = approved && !suspended;
          }

          await updateDocument('users', sellerId, updateData);
        } else {
          // Update vinylSellers document (legacy)
          const updateData: Record<string, unknown> = {
            updatedAt: new Date().toISOString()
          };

          if (storeName !== undefined) updateData.storeName = storeName;
          if (description !== undefined) updateData.description = description;
          if (location !== undefined) updateData.location = location;
          if (discogsUrl !== undefined) updateData.discogsUrl = discogsUrl;
          if (approved !== undefined) updateData.approved = approved;
          if (suspended !== undefined) updateData.suspended = suspended;

          await updateDocument('vinylSellers', sellerId, updateData);

          // Also update the user's roles if approval status changed
          if (approved !== undefined || suspended !== undefined) {
            try {
              const userId = seller.userId || sellerId;
              await updateDocument('users', userId, {
                'roles.vinylSeller': approved && !suspended,
                updatedAt: new Date().toISOString()
              });
            } catch (e: unknown) {
              log.error('Failed to update user roles:', e);
            }
          }
        }

        return successResponse({ message: 'Seller updated' });
      }

      case 'suspend': {
        if (collection === 'users') {
          await updateDocument('users', sellerId, {
            suspended: true,
            'roles.vinylSeller': false,
            updatedAt: new Date().toISOString()
          });
        } else {
          await updateDocument('vinylSellers', sellerId, {
            suspended: true,
            suspendedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });

          // Update user's role
          try {
            const userId = seller.userId || sellerId;
            await updateDocument('users', userId, {
              'roles.vinylSeller': false,
              updatedAt: new Date().toISOString()
            });
          } catch (e: unknown) {
            log.error('Failed to update user roles:', e);
          }
        }

        // Update all their listings to removed status
        try {
          const listings = await queryCollection('vinylListings', {
            filters: [{ field: 'sellerId', op: 'EQUAL', value: sellerId }]
          });

          for (const listing of listings) {
            if (listing.status === 'published') {
              await updateDocument('vinylListings', listing.id, {
                status: 'removed',
                removedReason: 'Seller suspended',
                updatedAt: new Date().toISOString()
              });
            }
          }
        } catch (e: unknown) {
          log.error('Failed to update listings:', e);
        }

        return successResponse({ message: 'Seller suspended' });
      }

      case 'unsuspend': {
        const isApproved = collection === 'users'
          ? (seller.approved || seller.partnerInfo?.approved)
          : seller.approved;

        if (collection === 'users') {
          await updateDocument('users', sellerId, {
            suspended: false,
            disabled: false,
            'roles.vinylSeller': isApproved ? true : false,
            updatedAt: new Date().toISOString()
          });
        } else {
          await updateDocument('vinylSellers', sellerId, {
            suspended: false,
            unsuspendedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });

          // Restore user's role if they're still approved
          if (isApproved) {
            try {
              const userId = seller.userId || sellerId;
              await updateDocument('users', userId, {
                'roles.vinylSeller': true,
                updatedAt: new Date().toISOString()
              });
            } catch (e: unknown) {
              log.error('Failed to update user roles:', e);
            }
          }
        }

        return successResponse({ message: 'Seller unsuspended' });
      }

      case 'delete': {
        // Soft delete - mark as deleted
        await updateDocument('vinylSellers', sellerId, {
          deleted: true,
          deletedAt: new Date().toISOString(),
          approved: false,
          suspended: true,
          updatedAt: new Date().toISOString()
        });

        // Remove user's role
        try {
          const userId = seller.userId || sellerId;
          await updateDocument('users', userId, {
            'roles.vinylSeller': false,
            updatedAt: new Date().toISOString()
          });
        } catch (e: unknown) {
          log.error('Failed to update user roles:', e);
        }

        return successResponse({ message: 'Seller deleted' });
      }

      default:
        return ApiErrors.badRequest('Invalid action');
    }
  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Server error');
  }
};
