// /src/pages/api/admin/reject-partner.ts
// API endpoint to reject (delete) a partner application

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { deleteDocument, getDocument, updateDocument } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { parseJsonBody, ApiErrors } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

const rejectPartnerSchema = z.object({
  partnerId: z.string().min(1),
  adminKey: z.string().optional(),
});

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`reject-partner:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  // Initialize Firebase for Cloudflare runtime
  const env = locals.runtime.env;


  try {
    const body = await parseJsonBody<{ partnerId?: string }>(request);

    // Check admin authentication
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const parsed = rejectPartnerSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { partnerId } = parsed.data;

    // Delete partner document from artists collection
    await deleteDocument('artists', partnerId);

    // Also update users collection to remove partner roles
    const userDoc = await getDocument('users', partnerId);
    if (userDoc) {
      const existingRoles = userDoc.roles || {};
      await updateDocument('users', partnerId, {
        roles: {
          ...existingRoles,
          artist: false,
          merchSupplier: false
        },
        partnerInfo: {
          ...(userDoc.partnerInfo || {}),
          approved: false,
          rejectedAt: new Date().toISOString()
        }
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Error rejecting partner:', error);
    return ApiErrors.serverError('Failed to reject partner');
  }
};