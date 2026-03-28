// src/pages/api/admin/create-pending-payout.ts
// Admin endpoint to create a pending payout record

import type { APIRoute } from 'astro';

import { saSetDocument, saUpdateDocument } from '../../../lib/firebase-service-account';
import { getAdminFirebaseContext } from '../../../lib/firebase/admin-context';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { parseJsonBody, ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';
import { z } from 'zod';
const log = createLogger('admin/create-pending-payout');
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

const pendingPayoutSchema = z.object({
  payoutData: z.object({
    artistId: z.string().min(1),
    artistName: z.string().min(1),
    artistEmail: z.string().email().optional(),
    orderId: z.string().min(1),
    orderNumber: z.string().optional(),
    amount: z.number().positive(),
    itemAmount: z.number().optional(),
    currency: z.string().optional(),
    notes: z.string().optional(),
  }),
  updateArtistBalance: z.boolean().optional(),
});

export const prerender = false;


export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`create-pending-payout:${clientId}`, RateLimiters.adminDelete);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const fbCtx = getAdminFirebaseContext(locals);
  if (fbCtx instanceof Response) return fbCtx;
  const { env, projectId, saKey: serviceAccountKey } = fbCtx;

  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });

  const body = await parseJsonBody(request);
  const authError = await requireAdminAuth(request, locals, body);
  if (authError) return authError;

  try {
    const parsed = pendingPayoutSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request: payoutData with artistId, artistName, orderId, and amount required');
    }

    const { payoutData, updateArtistBalance } = parsed.data;

    const now = new Date().toISOString();
    const pendingPayout = {
      artistId: payoutData.artistId,
      artistName: payoutData.artistName,
      artistEmail: payoutData.artistEmail,
      orderId: payoutData.orderId,
      orderNumber: payoutData.orderNumber,
      amount: payoutData.amount,
      itemAmount: payoutData.itemAmount || payoutData.amount,
      currency: payoutData.currency || 'gbp',
      status: 'pending',
      payoutMethod: null,
      notes: payoutData.notes || '',
      createdAt: now,
      updatedAt: now
    };

    // Create pending payout with generated ID
    const payoutId = `payout_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    await saSetDocument(serviceAccountKey, projectId, 'pendingPayouts', payoutId, pendingPayout);
    log.info('[create-pending-payout] Created:', payoutId);

    // Optionally update artist's pending balance
    if (updateArtistBalance && payoutData.artistId) {
      try {
        await saUpdateDocument(serviceAccountKey, projectId, 'artists', payoutData.artistId, {
          pendingBalance: { increment: payoutData.amount }
        });
        log.info('[create-pending-payout] Updated artist pending balance');
      } catch (e: unknown) {
        log.info('[create-pending-payout] Could not update artist balance (artist doc may not exist)');
      }
    }

    return successResponse({ payoutId: payoutId,
      amount: payoutData.amount,
      artistName: payoutData.artistName });

  } catch (error: unknown) {
    log.error('[create-pending-payout] Error:', error);
    return ApiErrors.serverError('Unknown error');
  }
};
