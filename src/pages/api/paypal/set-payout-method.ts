// src/pages/api/paypal/set-payout-method.ts
// Set preferred payout method (stripe or paypal)

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { saUpdateDocument } from '../../../lib/firebase-service-account';
import { createLogger, ApiErrors, successResponse } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../../lib/rate-limit';

const log = createLogger('[set-payout-method]');

// Zod schema for set payout method
const SetPayoutMethodSchema = z.object({
  entityType: z.enum(['artist', 'supplier', 'user']),
  entityId: z.string().optional(),
  payoutMethod: z.enum(['stripe', 'paypal']),
  accessCode: z.string().optional(),
}).passthrough();

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: 10 per minute for payout method changes
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`paypal-payout-method:${clientId}`, { maxRequests: 10, windowMs: 60 * 1000 });
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter);
  }

  const env = locals.runtime.env;
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;



  // SECURITY: Verify user authentication via Firebase token
  const { userId: authUserId, error: authError } = await verifyRequestUser(request);
  if (!authUserId || authError) {
    return ApiErrors.unauthorized('Authentication required');
  }

  if (!clientEmail || !privateKey) {
    log.error('Service account not configured');
    return ApiErrors.serverError('Service account not configured');
  }

  // Build service account key
  const serviceAccountKey = JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'auto',
    private_key: privateKey.replace(/\\n/g, '\n'),
    client_email: clientEmail,
    client_id: '',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token'
  });

  try {
    const rawBody = await request.json();

    const parseResult = SetPayoutMethodSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { entityType, entityId, payoutMethod, accessCode } = parseResult.data;

    // SECURITY: Verify the authenticated user matches the entity being modified
    if ((entityType === 'user' || entityType === 'artist') && entityId && authUserId !== entityId) {
      return ApiErrors.forbidden('Forbidden');
    }

    // Get entity
    let collection: string;
    let entity: Record<string, unknown> | null = null;
    let docId = entityId;

    switch (entityType) {
      case 'artist':
        collection = 'artists';
        if (entityId) entity = await getDocument('artists', entityId);
        break;

      case 'supplier':
        collection = 'merch-suppliers';
        if (entityId) {
          entity = await getDocument('merch-suppliers', entityId);
        } else if (accessCode) {
          const { queryCollection } = await import('../../../lib/firebase-rest');
          const suppliers = await queryCollection('merch-suppliers', { limit: 100 });
          const found = suppliers.find((s: Record<string, unknown>) => s.accessCode === accessCode);
          if (found) {
            entity = found;
            docId = found.id;
          }
        }
        break;

      case 'user':
        collection = 'users';
        if (entityId) entity = await getDocument('users', entityId);
        break;

      default:
        collection = '';
    }

    if (!entity) {
      return ApiErrors.notFound('${entityType} not found');
    }

    // Verify the chosen method is available
    if (payoutMethod === 'stripe') {
      if (!entity.stripeConnectId || entity.stripeConnectStatus !== 'active') {
        return ApiErrors.badRequest('Stripe Connect not set up. Please complete Stripe onboarding first.');
      }
    } else if (payoutMethod === 'paypal') {
      if (!entity.paypalEmail) {
        return ApiErrors.badRequest('PayPal not linked. Please link your PayPal email first.');
      }
    }

    // Update preference using service account auth
    await saUpdateDocument(serviceAccountKey, projectId, collection, docId, {
      payoutMethod,
      payoutMethodUpdatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    log.info(`Set ${entityType} ${docId} payout method to:`, payoutMethod);

    return successResponse({ payoutMethod,
      message: `Payout method set to ${payoutMethod === 'stripe' ? 'Stripe' : 'PayPal'}` });

  } catch (error: unknown) {
    log.error('Set method error:', error);
    return ApiErrors.serverError('Failed to set payout method');
  }
};
