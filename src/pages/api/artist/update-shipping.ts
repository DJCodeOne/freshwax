// src/pages/api/artist/update-shipping.ts
// Update artist's default vinyl shipping rates
// Uses service account for writes to ensure Firebase security rules don't block

import type { APIRoute } from 'astro';
import { getDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { saUpdateDocument } from '../../../lib/firebase-service-account';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

// Build service account key from individual env vars
function getServiceAccountKey(env: any): string | null {
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) return null;

  return JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'auto',
    private_key: privateKey.replace(/\\n/g, '\n'),
    client_email: clientEmail,
    client_id: '',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token'
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`update-shipping:${clientId}`, RateLimiters.write);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = (locals as any)?.runtime?.env;


  try {
    // SECURITY: Verify user authentication
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
    if (authError || !verifiedUserId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Authentication required'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const body = await request.json();
    const { artistId, vinylShippingUK, vinylShippingEU, vinylShippingIntl, vinylShipsFrom } = body;

    if (!artistId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Artist ID required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Verify the authenticated user matches the artistId
    if (verifiedUserId !== artistId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'You can only update your own shipping rates'
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate shipping rates (must be non-negative if provided)
    const validateRate = (rate: any, name: string) => {
      if (rate !== null && rate !== undefined) {
        const num = parseFloat(rate);
        if (isNaN(num) || num < 0) {
          throw new Error(`Invalid ${name} rate`);
        }
        return num;
      }
      return null;
    };

    const shippingUK = validateRate(vinylShippingUK, 'UK');
    const shippingEU = validateRate(vinylShippingEU, 'EU');
    const shippingIntl = validateRate(vinylShippingIntl, 'International');

    // Verify artist exists
    const artist = await getDocument('artists', artistId);
    if (!artist) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Artist not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // Build update object (only include non-null values)
    const updateData: Record<string, any> = {
      updatedAt: new Date().toISOString()
    };

    // Update or remove shipping rates
    if (shippingUK !== null) {
      updateData.vinylShippingUK = shippingUK;
    }
    if (shippingEU !== null) {
      updateData.vinylShippingEU = shippingEU;
    }
    if (shippingIntl !== null) {
      updateData.vinylShippingIntl = shippingIntl;
    }
    if (vinylShipsFrom) {
      updateData.vinylShipsFrom = vinylShipsFrom.trim();
    }

    // Get service account key for writes
    const serviceAccountKey = getServiceAccountKey(env);
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      console.error('[Artist] Service account not configured');
      return new Response(JSON.stringify({
        success: false,
        error: 'Service account not configured'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    await saUpdateDocument(serviceAccountKey, projectId, 'artists', artistId, updateData);

    console.log('[Artist] Updated shipping rates for:', artistId, updateData);

    return new Response(JSON.stringify({
      success: true,
      message: 'Shipping rates updated',
      data: {
        vinylShippingUK: shippingUK,
        vinylShippingEU: shippingEU,
        vinylShippingIntl: shippingIntl,
        vinylShipsFrom: vinylShipsFrom || null
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[Artist] Update shipping error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to update shipping rates'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
