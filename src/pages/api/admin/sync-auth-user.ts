// src/pages/api/admin/sync-auth-user.ts
// Admin endpoint to sync a Firebase Auth user to the users collection
// Use when a user exists in Auth but not in Firestore

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { saSetDocument, saGetDocument } from '../../../lib/firebase-service-account';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const syncAuthUserSchema = z.object({
  uid: z.string().min(1).max(200),
  email: z.string().email().max(320),
  displayName: z.string().max(200).optional(),
  idToken: z.string().max(5000).optional(),
}).strip();

const log = createLogger('admin/sync-auth-user');

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`sync-auth-user:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  try {
    const env = locals.runtime.env;
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

    if (!clientEmail || !privateKey) {
      return ApiErrors.serverError('Service account not configured');
    }

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

    const body = await request.json();
    initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const parsed = syncAuthUserSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request: uid (string) and email (valid email) are required');
    }

    const { uid, email, displayName } = parsed.data;

    // Check if user already exists
    const existing = await saGetDocument(serviceAccountKey, projectId, 'users', uid);
    if (existing) {
      return ApiErrors.badRequest('User already exists in Firestore');
    }

    // Create user document
    const userData = {
      email: email,
      displayName: displayName || email.split('@')[0],
      fullName: displayName || '',
      roles: {
        customer: true,
        dj: true,
        artist: false,
        merchSupplier: false,
        vinylSeller: false,
        admin: false
      },
      permissions: {
        canBuy: true,
        canComment: true,
        canRate: true
      },
      approved: false,
      suspended: false,
      createdAt: new Date().toISOString(),
      registeredAt: new Date().toISOString(),
      syncedFromAuth: true,
      syncedAt: new Date().toISOString()
    };

    await saSetDocument(serviceAccountKey, projectId, 'users', uid, userData);

    return successResponse({ message: 'User synced to Firestore',
      user: { id: uid, ...userData } });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Unknown error');
  }
};
