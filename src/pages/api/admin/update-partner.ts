// src/pages/api/admin/update-partner.ts
// Server-side API to update partner data for admin dashboard
// Uses Firebase REST API - only updates fields allowed by Firestore rules

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, clearCache } from '../../../lib/firebase-rest';
import { isAdmin, requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger } from '../../../lib/api-utils';

const logger = createLogger('update-partner');

const updatePartnerSchema = z.object({
  adminUid: z.string().min(1),
  partnerId: z.string().min(1),
  updates: z.object({}).passthrough().optional(),
}).passthrough();

export const prerender = false;

// Helper to initialize Firebase and admin config
function initServices(locals: App.Locals) {
  const env = locals?.runtime?.env || {};

  initAdminEnv({ ADMIN_UIDS: env.ADMIN_UIDS, ADMIN_EMAILS: env.ADMIN_EMAILS });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`update-partner:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  initServices(locals);

  try {
    const body = await request.json();
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const parsed = updatePartnerSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { adminUid, partnerId, updates } = parsed.data;
    const idToken = (body as any).idToken;

    logger.info('[update-partner] Request:', { adminUid, partnerId, hasToken: !!idToken, updates });

    const now = new Date().toISOString();
    const results: string[] = [];

    // Get current docs
    const [userDoc, artistDoc] = await Promise.all([
      getDocument('users', partnerId),
      getDocument('artists', partnerId)
    ]);

    logger.info('[update-partner] Found docs - users:', !!userDoc, 'artists:', !!artistDoc);

    // Update artists collection - this is the main partner data store
    // Allowed fields: isArtist, isMerchSupplier, revokedAt, revokedBy, updatedAt,
    //                 artistName, name, displayName, email, phone, approved, suspended, adminNotes
    if (artistDoc) {
      const artistUpdate: any = {
        updatedAt: now
      };

      // Basic info
      if (updates.name !== undefined) {
        artistUpdate.artistName = updates.name;
        artistUpdate.name = updates.name;
        artistUpdate.displayName = updates.name;
      }
      if (updates.email !== undefined) artistUpdate.email = updates.email;
      if (updates.phone !== undefined) artistUpdate.phone = updates.phone;
      if (updates.adminNotes !== undefined) artistUpdate.adminNotes = updates.adminNotes;

      // Roles
      if (updates.isArtist !== undefined) artistUpdate.isArtist = updates.isArtist;
      if (updates.isMerchSupplier !== undefined) artistUpdate.isMerchSupplier = updates.isMerchSupplier;
      if (updates.isVinylSeller !== undefined) artistUpdate.isVinylSeller = updates.isVinylSeller;

      // Status
      if (updates.approved !== undefined) artistUpdate.approved = updates.approved;
      if (updates.suspended !== undefined) artistUpdate.suspended = updates.suspended;

      try {
        await updateDocument('artists', partnerId, artistUpdate, idToken);
        results.push('artists:updated');
        logger.info('[update-partner] Updated artists:', artistUpdate);
      } catch (e) {
        logger.error('[update-partner] artists update failed:', e);
        return ApiErrors.serverError('Failed to update partner: ');
      }
    }

    // Update or create users collection document
    // This is the source of truth for list-partners API
    const userUpdate: any = {
      updatedAt: now
    };

    if (updates.name !== undefined) userUpdate.displayName = updates.name;
    if (updates.phone !== undefined) userUpdate.phone = updates.phone;
    if (updates.approved !== undefined) userUpdate.approved = updates.approved;

    // Build roles object
    userUpdate.roles = {
      customer: true,
      dj: true,
      artist: updates.isArtist ?? userDoc?.roles?.artist ?? artistDoc?.isArtist ?? false,
      merchSupplier: updates.isMerchSupplier ?? userDoc?.roles?.merchSupplier ?? artistDoc?.isMerchSupplier ?? false,
      vinylSeller: updates.isVinylSeller ?? userDoc?.roles?.vinylSeller ?? artistDoc?.isVinylSeller ?? false,
      admin: updates.isAdmin ?? userDoc?.roles?.admin ?? false
    };

    try {
      if (userDoc) {
        // Update existing users document
        await updateDocument('users', partnerId, userUpdate, idToken);
        results.push('users:updated');
        logger.info('[update-partner] Updated users:', userUpdate);
      } else {
        // Create users document if it doesn't exist (required for list-partners)
        const { setDocument } = await import('../../../lib/firebase-rest');
        await setDocument('users', partnerId, {
          uid: partnerId,
          email: updates.email || artistDoc?.email || '',
          displayName: updates.name || artistDoc?.artistName || artistDoc?.name || '',
          fullName: updates.name || artistDoc?.artistName || artistDoc?.name || '',
          approved: updates.approved !== false,
          roles: userUpdate.roles,
          createdAt: artistDoc?.createdAt || now,
          updatedAt: now
        }, idToken);
        results.push('users:created');
        logger.info('[update-partner] Created users document:', partnerId);
      }
    } catch (e) {
      logger.warn('[update-partner] users update failed:', e instanceof Error ? e.message : e);
    }

    // Update or create customers collection record
    // This ensures downgraded partners appear in User Management
    try {
      const customerDoc = await getDocument('users', partnerId);
      const isBeingDowngraded = updates.isArtist === false && updates.isMerchSupplier === false && updates.isVinylSeller === false;

      if (customerDoc) {
        // Update existing customer record
        const customerUpdate: any = {
          updatedAt: now
        };

        if (updates.phone !== undefined) customerUpdate.phone = updates.phone;
        if (updates.isArtist !== undefined) customerUpdate.isArtist = updates.isArtist;
        if (updates.isMerchSupplier !== undefined) customerUpdate.isMerchSupplier = updates.isMerchSupplier;
        if (updates.isVinylSeller !== undefined) customerUpdate.isVinylSeller = updates.isVinylSeller;
        if (updates.approved !== undefined) customerUpdate.approved = updates.approved;

        customerUpdate.roles = {
          customer: true,
          dj: true,
          artist: updates.isArtist ?? customerDoc.roles?.artist ?? false,
          merch: updates.isMerchSupplier ?? customerDoc.roles?.merch ?? false,
          vinylSeller: updates.isVinylSeller ?? customerDoc.roles?.vinylSeller ?? false
        };

        await updateDocument('users', partnerId, customerUpdate, idToken);
        results.push('customers:updated');
      } else if (isBeingDowngraded && artistDoc) {
        // Create customers record for downgraded partner so they appear in User Management
        const { setDocument } = await import('../../../lib/firebase-rest');
        await setDocument('users', partnerId, {
          uid: partnerId,
          displayName: updates.name || artistDoc.artistName || artistDoc.name || '',
          name: updates.name || artistDoc.artistName || artistDoc.name || '',
          email: updates.email || artistDoc.email || '',
          phone: updates.phone || artistDoc.phone || '',
          isDJ: true,
          isArtist: false,
          isMerchSupplier: false,
          isVinylSeller: false,
          roles: {
            customer: true,
            dj: true,
            artist: false,
            merch: false,
            vinylSeller: false
          },
          approved: true,
          createdAt: artistDoc.createdAt || now,
          updatedAt: now
        }, idToken);
        results.push('customers:created');
        logger.info('[update-partner] Created customers record for downgraded partner');
      }
    } catch (e) {
      logger.warn('[update-partner] customers update failed:', e instanceof Error ? e.message : e);
    }

    // Update or create vinylSellers collection record
    if (updates.isVinylSeller !== undefined) {
      try {
        const vinylSellerDoc = await getDocument('vinylSellers', partnerId);

        if (updates.isVinylSeller === true && !vinylSellerDoc) {
          // Create vinylSellers record for newly promoted user
          const { setDocument } = await import('../../../lib/firebase-rest');
          await setDocument('vinylSellers', partnerId, {
            id: partnerId,
            userId: partnerId,
            storeName: updates.name || artistDoc?.artistName || 'Vinyl Store',
            description: '',
            location: '',
            discogsUrl: '',
            approved: updates.approved !== false,
            suspended: false,
            ratings: { average: 0, count: 0, breakdown: { communication: 0, accuracy: 0, shipping: 0 } },
            totalSales: 0,
            totalListings: 0,
            createdAt: now,
            updatedAt: now
          }, idToken);
          results.push('vinylSellers:created');
          logger.info('[update-partner] Created vinylSellers record for promoted partner');
        } else if (vinylSellerDoc) {
          // Update existing vinylSellers record
          await updateDocument('vinylSellers', partnerId, {
            approved: updates.isVinylSeller && updates.approved !== false,
            suspended: updates.suspended === true || updates.isVinylSeller === false,
            updatedAt: now
          }, idToken);
          results.push('vinylSellers:updated');
        }
      } catch (e) {
        logger.warn('[update-partner] vinylSellers update failed:', e instanceof Error ? e.message : e);
      }
    }

    logger.info('[update-partner] Completed:', results);

    // Invalidate caches so list-partners sees the update immediately
    clearCache('users');
    clearCache('artists');
    clearCache('query:users');

    return new Response(JSON.stringify({
      success: true,
      message: 'Partner updated successfully',
      results
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: unknown) {
    logger.error('[update-partner] Error:', error);
    return ApiErrors.serverError('Failed to update partner');
  }
};
