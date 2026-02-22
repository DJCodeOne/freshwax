// src/pages/api/admin/extend-subscription.ts
// Admin endpoint to extend a user's Plus subscription

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument } from '../../../lib/firebase-rest';
import { saUpdateDocument } from '../../../lib/firebase-service-account';
import { requireAdminAuth } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('[extend-subscription]');

const extendSubscriptionSchema = z.object({
  userId: z.string().min(1),
  days: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  reason: z.string().optional(),
  adminKey: z.string().optional(),
});

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;

  // Rate limit
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`extend-subscription:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  try {
    const body = await request.json();

    // SECURITY: Require admin authentication
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const parsed = extendSubscriptionSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { userId, days, reason } = parsed.data;

    // Get current user data
    const user = await getDocument('users', userId);

    if (!user) {
      return ApiErrors.notFound('User not found');
    }

    // Calculate new expiry date
    let baseDate: Date;

    if (user.subscription?.expiresAt) {
      const currentExpiry = new Date(user.subscription.expiresAt);
      // If not expired, extend from current expiry; if expired, extend from now
      baseDate = currentExpiry > new Date() ? currentExpiry : new Date();
    } else {
      baseDate = new Date();
    }

    const newExpiry = new Date(baseDate);
    newExpiry.setDate(newExpiry.getDate() + parseInt(days));

    // Add extension log
    const extensionLog = {
      extendedAt: new Date().toISOString(),
      daysAdded: parseInt(days),
      reason: reason || 'Admin extension',
      previousExpiry: user.subscription?.expiresAt || null,
      newExpiry: newExpiry.toISOString()
    };

    // Get existing extension history or create new array
    const extensionHistory = user.subscription?.extensionHistory || [];
    extensionHistory.push(extensionLog);

    // Build complete subscription object, preserving all existing fields
    const subscriptionObj = {
      ...user.subscription,
      tier: 'pro',
      expiresAt: newExpiry.toISOString(),
      subscribedAt: user.subscription?.subscribedAt || new Date().toISOString(),
      extensionHistory: extensionHistory,
    };

    // Update entire subscription object
    const updateData: Record<string, any> = {
      subscription: subscriptionObj
    };

    // Use service account auth to update user document
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

    if (!clientEmail || !privateKey) {
      return ApiErrors.serverError('Service account not configured');
    }

    // Construct service account key JSON from individual env vars
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

    log.info(`[extend-subscription] Attempting update for ${userId}:`, JSON.stringify(updateData));

    try {
      await saUpdateDocument(serviceAccountKey, projectId, 'users', userId, updateData);
      log.info(`[extend-subscription] Update successful for ${userId}`);
    } catch (updateErr: unknown) {
      log.error(`[extend-subscription] Update failed:`, updateErr);
      throw updateErr;
    }

    log.info(`[extend-subscription] Extended ${userId} by ${days} days until ${newExpiry.toISOString()}`);

    return successResponse({ newExpiry: newExpiry.toISOString(),
      message: `Subscription extended by ${days} days` });

  } catch (error: unknown) {
    log.error('[extend-subscription] Error:', error);
    return ApiErrors.serverError('Failed to extend subscription');
  }
};
