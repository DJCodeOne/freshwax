// src/pages/api/admin/send-stripe-payout.ts
// Operator-triggered Stripe payout: transfers ALL payable pendingPayouts
// rows for one connected partner. Payouts are manual by operator policy —
// this is the button the operator presses after checking the platform
// balance. Reuses the same engine as the (opt-in) Connect activation flow.

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument } from '../../../lib/firebase-rest';
import { processPendingPayouts } from '../../../lib/stripe-connect-payouts';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const sendStripePayoutSchema = z.object({
  entityType: z.enum(['artist', 'supplier', 'user']).default('artist'),
  entityId: z.string().min(1).max(200),
  adminKey: z.string().max(500).optional(),
  idToken: z.string().max(5000).optional(),
}).strip();

const log = createLogger('admin/send-stripe-payout');

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`send-stripe-payout:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  try {
    const body = await request.json();
    const env = locals.runtime.env;
    initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const parsed = sendStripePayoutSchema.safeParse(body);
    if (!parsed.success) return ApiErrors.badRequest('entityId is required');
    const { entityType, entityId } = parsed.data;

    const stripeSecretKey = env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY;
    if (!stripeSecretKey) return ApiErrors.serverError('Stripe not configured');

    const collection = entityType === 'supplier' ? 'merch-suppliers' : entityType === 'user' ? 'users' : 'artists';
    const entity = await getDocument(collection, entityId);
    if (!entity) return ApiErrors.notFound('Partner not found');
    const stripeConnectId = entity.stripeConnectId;
    if (typeof stripeConnectId !== 'string' || !stripeConnectId || entity.stripeConnectStatus !== 'active') {
      return ApiErrors.badRequest('Partner does not have an active Stripe Connect account');
    }

    const result = await processPendingPayouts(entityType, entityId, stripeConnectId, stripeSecretKey as string, env as Record<string, unknown>);
    log.info(`Manual Stripe payout for ${entityType} ${entityId}: ${result.processed} transferred (£${result.transferredAmount.toFixed(2)}), ${result.failed} failed`);

    return successResponse({
      entityId,
      entityName: entity.artistName || entity.name || '',
      processed: result.processed,
      transferredAmount: Math.round(result.transferredAmount * 100) / 100,
      failed: result.failed,
      message: result.processed === 0 && result.failed === 0
        ? 'Nothing payable for this partner'
        : `${result.processed} payout(s) sent (£${result.transferredAmount.toFixed(2)})${result.failed ? `, ${result.failed} failed — check the platform balance and retry` : ''}`,
    });
  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Unknown error');
  }
};
