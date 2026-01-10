// src/pages/api/admin/extend-subscription.ts
// Admin endpoint to extend a user's Plus subscription

import type { APIRoute } from 'astro';
import { getDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { saUpdateDocument } from '../../../lib/firebase-service-account';
import { requireAdminAuth } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  // Rate limit
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`extend-subscription:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  try {
    const body = await request.json();
    const { userId, days, reason } = body;

    // SECURITY: Require admin authentication
    const authError = requireAdminAuth(request, locals, body);
    if (authError) return authError;

    if (!userId || !days) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User ID and days required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Get current user data
    const user = await getDocument('users', userId);

    if (!user) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
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

    // Build complete subscription object to replace
    const subscriptionObj = {
      tier: 'pro',
      expiresAt: newExpiry.toISOString(),
      subscribedAt: user.subscription?.subscribedAt || new Date().toISOString(),
      extensionHistory: extensionHistory,
      // Preserve existing fields
      ...(user.subscription?.source && { source: user.subscription.source }),
      ...(user.subscription?.startedAt && { startedAt: user.subscription.startedAt }),
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
      return new Response(JSON.stringify({
        success: false,
        error: 'Service account not configured'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
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

    console.log(`[extend-subscription] Attempting update for ${userId}:`, JSON.stringify(updateData));

    try {
      await saUpdateDocument(serviceAccountKey, projectId, 'users', userId, updateData);
      console.log(`[extend-subscription] Update successful for ${userId}`);
    } catch (updateErr) {
      console.error(`[extend-subscription] Update failed:`, updateErr);
      throw updateErr;
    }

    console.log(`[extend-subscription] Extended ${userId} by ${days} days until ${newExpiry.toISOString()}`);

    return new Response(JSON.stringify({
      success: true,
      newExpiry: newExpiry.toISOString(),
      message: `Subscription extended by ${days} days`
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[extend-subscription] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to extend subscription'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
