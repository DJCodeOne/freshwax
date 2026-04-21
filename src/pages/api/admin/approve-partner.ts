// /src/pages/api/admin/approve-partner.ts
// API endpoint to approve a partner

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { updateDocument, getDocument, setDocument } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { parseJsonBody, ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('admin/approve-partner');
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

const approvePartnerSchema = z.object({
  partnerId: z.string().min(1),
  adminKey: z.string().optional(),
});

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`approve-partner:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  // Admin authentication
  const body = await parseJsonBody(request);
  const authError = await requireAdminAuth(request, locals, body);
  if (authError) return authError;

  // Initialize Firebase for Cloudflare runtime
  const env = locals.runtime.env;


  try {
    const parsed = approvePartnerSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { partnerId } = parsed.data;

    const now = new Date().toISOString();

    // Get the artist document to check their roles
    const artistDoc = await getDocument('artists', partnerId);

    // Update artists collection
    await updateDocument('artists', partnerId, {
      approved: true,
      approvedAt: now,
      status: 'approved'
    });

    // Also update users collection for consistency
    const userDoc = await getDocument('users', partnerId);
    if (userDoc) {
      const existingRoles = userDoc.roles || {};
      await updateDocument('users', partnerId, {
        approved: true,
        roles: {
          ...existingRoles,
          artist: existingRoles.artist || artistDoc?.isArtist || true,
          merchSupplier: existingRoles.merchSupplier || artistDoc?.isMerchSupplier || false
        },
        partnerInfo: {
          ...(userDoc.partnerInfo || {}),
          approved: true,
          approvedAt: now
        }
      });
    }

    // Create partners document — any approved role (artist, label, merch, vinyl) becomes a partner
    const existingPartner = await getDocument('partners', partnerId);
    if (!existingPartner) {
      const partnerData: Record<string, unknown> = {
        partnerId,
        artistName: artistDoc?.artistName || artistDoc?.name || userDoc?.displayName || '',
        name: artistDoc?.name || artistDoc?.artistName || userDoc?.displayName || '',
        email: artistDoc?.email || userDoc?.email || '',
        bio: artistDoc?.bio || '',
        links: artistDoc?.links || '',
        isArtist: artistDoc?.isArtist || false,
        isLabel: artistDoc?.isLabel || false,
        isMerchSupplier: artistDoc?.isMerchSupplier || false,
        isVinylSeller: artistDoc?.isVinylSeller || false,
        isDJ: artistDoc?.isDJ || false,
        approved: true,
        approvedAt: now,
        approvedBy: 'admin',
        createdAt: artistDoc?.createdAt || now,
        promotedAt: now,
        suspended: false,
        userId: partnerId,
      };
      await setDocument('partners', partnerId, partnerData);
      log.info('Created partners document for', partnerId);
    }

    return successResponse({});

  } catch (error: unknown) {
    log.error('Error approving partner:', error);
    return ApiErrors.serverError('Failed to approve partner');
  }
};