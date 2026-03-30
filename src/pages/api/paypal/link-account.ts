// src/pages/api/paypal/link-account.ts
// Link a PayPal email for payouts (artists, suppliers, users)

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { saUpdateDocument } from '../../../lib/firebase-service-account';
import { createLogger, ApiErrors, successResponse } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../../lib/rate-limit';

const log = createLogger('[link-account]');

// Zod schemas for PayPal link account
const LinkAccountPostSchema = z.object({
  entityType: z.enum(['artist', 'supplier', 'user']),
  entityId: z.string().optional(),
  paypalEmail: z.string().email('Valid PayPal email required'),
  accessCode: z.string().optional(),
}).strip();

const LinkAccountGetSchema = z.object({
  entityType: z.enum(['artist', 'supplier', 'user']),
  entityId: z.string().optional(),
  accessCode: z.string().optional(),
}).refine(data => data.entityId || data.accessCode, {
  message: 'Entity ID or access code required',
});

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: 10 per minute for PayPal account linking
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`paypal-link:${clientId}`, { maxRequests: 10, windowMs: 60 * 1000 });
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

    const parseResult = LinkAccountPostSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { entityType, entityId, paypalEmail, accessCode } = parseResult.data;

    // SECURITY: Verify the authenticated user matches the entity being modified
    if ((entityType === 'user' || entityType === 'artist') && entityId && authUserId !== entityId) {
      return ApiErrors.forbidden('Forbidden');
    }

    // Get the entity document
    let collection: string;
    let entity: Record<string, unknown> | null = null;
    let docId = entityId;

    switch (entityType) {
      case 'artist':
        collection = 'artists';
        if (entityId) {
          entity = await getDocument('artists', entityId);
        }
        break;

      case 'supplier':
        collection = 'merch-suppliers';
        if (entityId) {
          entity = await getDocument('merch-suppliers', entityId);
        } else if (accessCode) {
          // Look up by access code
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
        if (entityId) {
          entity = await getDocument('users', entityId);
        }
        break;

      default:
        collection = '';
    }

    if (!entity) {
      return ApiErrors.notFound(`${entityType} not found`);
    }

    // Update with PayPal info using service account auth
    const updateData = {
      paypalEmail: paypalEmail.toLowerCase(),
      paypalLinkedAt: new Date().toISOString(),
      payoutMethod: 'paypal', // Set as preferred method
      updatedAt: new Date().toISOString()
    };

    log.info(`Updating ${entityType} ${docId} with:`, JSON.stringify(updateData));

    const updatedDoc = await saUpdateDocument(serviceAccountKey, projectId, collection, docId, updateData);

    log.info(`Updated document response:`, JSON.stringify(updatedDoc));

    return successResponse({ message: 'PayPal account linked successfully',
      paypalEmail: paypalEmail.toLowerCase(),
      savedData: {
        paypalEmail: updatedDoc.paypalEmail,
        payoutMethod: updatedDoc.payoutMethod
      } });

  } catch (error: unknown) {
    log.error('Link account error:', error);
    return ApiErrors.serverError('Failed to link PayPal account');
  }
};

// GET - Check PayPal link status
export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const rawParams = {
    entityType: url.searchParams.get('entityType') || '',
    entityId: url.searchParams.get('entityId') || undefined,
    accessCode: url.searchParams.get('accessCode') || undefined,
  };

  const paramResult = LinkAccountGetSchema.safeParse(rawParams);
  if (!paramResult.success) {
    return ApiErrors.badRequest('Invalid request');
  }
  const { entityType, entityId, accessCode } = paramResult.data;

  const env = locals.runtime.env;


  // SECURITY: Verify user authentication via Firebase token
  const { userId: authUserId, error: authError } = await verifyRequestUser(request);
  if (!authUserId || authError) {
    return ApiErrors.unauthorized('Authentication required');
  }

  // SECURITY: Verify the authenticated user matches the entity being queried
  if ((entityType === 'user' || entityType === 'artist') && entityId && authUserId !== entityId) {
    return ApiErrors.forbidden('Forbidden');
  }

  try {
    let entity: Record<string, unknown> | null = null;

    switch (entityType) {
      case 'artist':
        if (entityId) entity = await getDocument('artists', entityId);
        break;

      case 'supplier':
        if (entityId) {
          entity = await getDocument('merch-suppliers', entityId);
        } else if (accessCode) {
          const { queryCollection } = await import('../../../lib/firebase-rest');
          const suppliers = await queryCollection('merch-suppliers', { limit: 100 });
          entity = suppliers.find((s: Record<string, unknown>) => s.accessCode === accessCode) || null;
        }
        break;

      case 'user':
        if (entityId) entity = await getDocument('users', entityId);
        break;
    }

    if (!entity) {
      return ApiErrors.notFound(`${entityType} not found`);
    }

    return successResponse({ paypalEmail: entity.paypalEmail || null,
      paypalLinked: !!entity.paypalEmail,
      paypalLinkedAt: entity.paypalLinkedAt || null,
      payoutMethod: entity.payoutMethod || null,
      stripeConnected: !!entity.stripeConnectId && entity.stripeConnectStatus === 'active' });

  } catch (error: unknown) {
    log.error('Get status error:', error);
    return ApiErrors.serverError('Failed to get PayPal status');
  }
};
