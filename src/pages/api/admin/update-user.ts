// src/pages/api/admin/update-user.ts
// Server-side API to update user data for admin dashboard
// Uses Firebase REST API to bypass Firestore rules

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, setDocument } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('admin/update-user');

const updateUserSchema = z.object({
  userId: z.string().min(1),
  sourceCollection: z.string().optional(),
  updates: z.object({
    displayName: z.string().optional(),
    fullName: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    address: z.object({
      line1: z.string().optional(),
      line2: z.string().optional(),
      city: z.string().optional(),
      county: z.string().optional(),
      postcode: z.string().optional(),
      country: z.string().optional(),
    }).strip().optional(),
    roles: z.object({
      customer: z.boolean().optional(),
      dj: z.boolean().optional(),
      artist: z.boolean().optional(),
      merchSupplier: z.boolean().optional(),
    }).strip().optional(),
    isAdmin: z.boolean().optional(),
    permissions: z.record(z.string(), z.boolean()).optional(),
    approved: z.boolean().optional(),
    suspended: z.boolean().optional(),
    adminNotes: z.string().optional(),
  }).strip(),
  adminKey: z.string().optional(),
});

export const prerender = false;



export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`update-user:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  try {
    // Parse request body
    const body = await request.json();

    // SECURITY: Require admin authentication via admin key (not spoofable UID)
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const parsed = updateUserSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { userId, sourceCollection, updates } = parsed.data;

    const timestamp = new Date().toISOString();
    const results = {
      customers: false,
      users: false,
      artists: false
    };

    // Update customers collection - only include provided fields
    try {
      const customerDoc = await getDocument('users', userId);
      if (customerDoc) {
        const customerUpdate: Record<string, unknown> = { updatedAt: timestamp };

        if (updates.displayName !== undefined) {
          customerUpdate.displayName = updates.displayName;
          customerUpdate.name = updates.fullName || updates.displayName;
        }
        if (updates.fullName !== undefined) customerUpdate.fullName = updates.fullName;
        if (updates.email !== undefined) customerUpdate.email = updates.email;
        if (updates.phone !== undefined) customerUpdate.phone = updates.phone;
        if (updates.address !== undefined) customerUpdate.address = updates.address;
        if (updates.roles !== undefined) {
          customerUpdate.roles = updates.roles;
          customerUpdate.isDJ = updates.roles.dj ?? true;
          customerUpdate.isArtist = updates.roles.artist ?? false;
          customerUpdate.isMerchSupplier = updates.roles.merchSupplier ?? false;
        }
        if (updates.isAdmin !== undefined) customerUpdate.isAdmin = updates.isAdmin;
        if (updates.permissions !== undefined) customerUpdate.permissions = updates.permissions;
        if (updates.approved !== undefined) customerUpdate.approved = updates.approved;
        if (updates.suspended !== undefined) customerUpdate.suspended = updates.suspended;
        if (updates.adminNotes !== undefined) customerUpdate.adminNotes = updates.adminNotes;

        await updateDocument('users', userId, customerUpdate);
        results.customers = true;
      }
    } catch (e: unknown) {
      log.error('Error updating customers:', e);
    }

    // Update users collection - only include provided fields
    try {
      const userDoc = await getDocument('users', userId);
      if (userDoc) {
        const userUpdate: Record<string, unknown> = { updatedAt: timestamp };

        if (updates.displayName !== undefined) userUpdate.displayName = updates.displayName;
        // Note: email is immutable in users collection - use customers collection as source of truth
        if (updates.phone !== undefined) userUpdate.phone = updates.phone;
        if (updates.approved !== undefined) userUpdate.approved = updates.approved;
        if (updates.isAdmin !== undefined) userUpdate.isAdmin = updates.isAdmin;
        if (updates.roles !== undefined) userUpdate.roles = updates.roles;
        if (updates.permissions !== undefined) userUpdate.permissions = updates.permissions;

        await updateDocument('users', userId, userUpdate);
        results.users = true;
      }
    } catch (e: unknown) {
      log.error('Error updating users:', e);
    }

    // Update artists collection if user has artist/merch role OR source is artists
    const shouldUpdateArtists = updates.roles?.artist || updates.roles?.merchSupplier || sourceCollection === 'artists';
    if (shouldUpdateArtists) {
      try {
        const artistDoc = await getDocument('artists', userId);
        if (artistDoc) {
          // Only include fields that are explicitly provided
          const artistUpdate: Record<string, unknown> = { updatedAt: timestamp };

          if (updates.displayName !== undefined) {
            artistUpdate.artistName = updates.displayName;
            artistUpdate.displayName = updates.displayName;
            artistUpdate.name = updates.fullName || updates.displayName;
          }
          if (updates.email !== undefined) artistUpdate.email = updates.email;
          if (updates.phone !== undefined) artistUpdate.phone = updates.phone;
          if (updates.roles?.artist !== undefined) artistUpdate.isArtist = updates.roles.artist;
          if (updates.roles?.merchSupplier !== undefined) artistUpdate.isMerchSupplier = updates.roles.merchSupplier;
          if (updates.approved !== undefined) artistUpdate.approved = updates.approved;
          if (updates.suspended !== undefined) artistUpdate.suspended = updates.suspended;
          if (updates.adminNotes !== undefined) artistUpdate.adminNotes = updates.adminNotes;

          await updateDocument('artists', userId, artistUpdate);
          results.artists = true;
        } else if (updates.roles?.artist || updates.roles?.merchSupplier) {
          // Create artist doc if user has artist/merch roles
          await setDocument('artists', userId, {
            artistName: updates.displayName,
            displayName: updates.displayName,
            name: updates.fullName || updates.displayName,
            email: updates.email,
            phone: updates.phone,
            isArtist: updates.roles?.artist ?? false,
            isMerchSupplier: updates.roles?.merchSupplier ?? false,
            approved: updates.approved,
            suspended: updates.suspended,
            adminNotes: updates.adminNotes || '',
            userId: userId,
            registeredAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp
          });
          results.artists = true;
        }
      } catch (e: unknown) {
        log.error('Error updating artists:', e);
      }
    }

    // Check if at least one update succeeded
    const anySuccess = results.customers || results.users || results.artists;

    if (!anySuccess) {
      return ApiErrors.serverError('Failed to update any collections');
    }

    return successResponse({ message: 'User updated successfully',
      results });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to update user');
  }
};
