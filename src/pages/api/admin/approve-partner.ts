// /src/pages/api/admin/approve-partner.ts
// API endpoint to approve a partner

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { updateDocument, getDocument } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { parseJsonBody, ApiErrors } from '../../../lib/api-utils';
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

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Error approving partner:', error);
    return ApiErrors.serverError('Failed to approve partner');
  }
};