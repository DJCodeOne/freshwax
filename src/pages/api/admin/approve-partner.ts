// /src/pages/api/admin/approve-partner.ts
// API endpoint to approve a partner

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { updateDocument, getDocument, setDocument } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { resolvePendingRoleRequests } from '../../../lib/roles/pending-requests';
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
      const newRoles = {
        ...existingRoles,
        artist: existingRoles.artist || artistDoc?.isArtist || true,
        merchSupplier: existingRoles.merchSupplier || artistDoc?.isMerchSupplier || false
      };
      await updateDocument('users', partnerId, {
        approved: true,
        roles: newRoles,
        partnerInfo: {
          ...(userDoc.partnerInfo || {}),
          approved: true,
          approvedAt: now
        }
      });

      // Record the grant against their pending request(s). Without this the
      // request doc stays "pending" forever and the Approvals tab fills up with
      // partners who are already live — which is exactly how 13 accumulated
      // unnoticed. Only requests this grant actually satisfies are resolved;
      // anything else (e.g. a vinylSeller request, which this endpoint does not
      // grant) deliberately stays pending.
      const resolved = await resolvePendingRoleRequests(partnerId, newRoles);
      if (resolved > 0) log.info(`Resolved ${resolved} pending role request(s) for`, partnerId);
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