// src/pages/api/admin/create-pending-payout.ts
// Admin endpoint to create a pending payout record

import type { APIRoute } from 'astro';

import { saSetDocument, saUpdateDocument, getServiceAccountKey } from '../../../lib/firebase-service-account';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { parseJsonBody, ApiErrors, createLogger } from '../../../lib/api-utils';
const log = createLogger('[create-pending-payout]');
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;


export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`create-pending-payout:${clientId}`, RateLimiters.adminDelete);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals.runtime.env;
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
  const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;

  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });

  const body = await parseJsonBody(request);
  const authError = await requireAdminAuth(request, locals, body);
  if (authError) return authError;

  try {
    const { payoutData, updateArtistBalance } = body;

    if (!payoutData) {
      return ApiErrors.badRequest('payoutData required');
    }

    const serviceAccountKey = getServiceAccountKey(env);
    if (!serviceAccountKey) {
      return ApiErrors.serverError('Service account not configured');
    }

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

    return new Response(JSON.stringify({
      success: true,
      payoutId: payoutId,
      amount: payoutData.amount,
      artistName: payoutData.artistName
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    log.error('[create-pending-payout] Error:', error);
    return ApiErrors.serverError('Unknown error');
  }
};
