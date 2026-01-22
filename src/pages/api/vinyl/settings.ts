// src/pages/api/vinyl/settings.ts
// Vinyl seller settings API - D1 Primary, Firebase backup
// Handles shipping costs, store info, etc.

import type { APIRoute } from 'astro';
import { getDocument, setDocument, initFirebaseEnv, verifyRequestUser } from '../../../lib/firebase-rest';
import { d1GetVinylSeller, d1UpsertVinylSeller, d1GetNextCollectionNumber } from '../../../lib/d1-catalog';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../../lib/rate-limit';
import { saSetDocument } from '../../../lib/firebase-service-account';

export const prerender = false;

// Get service account key from environment
function getServiceAccountKey(env: any): string | null {
  let serviceAccountKey = env?.FIREBASE_SERVICE_ACCOUNT || env?.FIREBASE_SERVICE_ACCOUNT_KEY ||
                          import.meta.env.FIREBASE_SERVICE_ACCOUNT || import.meta.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (!serviceAccountKey) {
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
    const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

    if (clientEmail && privateKey) {
      serviceAccountKey = JSON.stringify({
        type: 'service_account',
        project_id: projectId,
        private_key_id: 'auto',
        private_key: privateKey.replace(/\\n/g, '\n'),
        client_email: clientEmail,
        client_id: 'auto',
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token'
      });
    }
  }

  return serviceAccountKey || null;
}

// Validation limits
const MAX_SHIPPING = 100; // £100 max
const MAX_STORE_NAME = 50;
const MAX_LOCATION = 50;
const MAX_DESCRIPTION = 500;

// Initialize Firebase from env
function initFirebase(locals: any) {
  const env = locals?.runtime?.env || {};
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

// GET - Fetch seller settings (D1 first, Firebase fallback)
export const GET: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  const env = (locals as any)?.runtime?.env || {};

  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');

  if (!userId) {
    return new Response(JSON.stringify({ success: false, error: 'User ID required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`vinyl-settings-read:${clientId}`, {
    maxRequests: 60,
    windowMs: 60 * 1000
  });

  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    let settings = null;
    let source = 'none';

    // Try D1 first (primary)
    const db = env.DB;
    if (db) {
      try {
        settings = await d1GetVinylSeller(db, userId);
        if (settings) {
          source = 'd1';
          console.log('[vinyl/settings GET] Loaded from D1:', userId);
        }
      } catch (d1Error) {
        console.error('[vinyl/settings GET] D1 error:', d1Error);
      }
    }

    // Fallback to Firebase if D1 failed or no data
    if (!settings) {
      try {
        settings = await getDocument('vinyl-sellers', userId);
        if (settings) {
          source = 'firebase';
          console.log('[vinyl/settings GET] Loaded from Firebase:', userId);

          // Backfill to D1 if available
          if (db && settings) {
            try {
              await d1UpsertVinylSeller(db, userId, settings);
              console.log('[vinyl/settings GET] Backfilled to D1:', userId);
            } catch (backfillError) {
              console.error('[vinyl/settings GET] D1 backfill failed:', backfillError);
            }
          }
        }
      } catch (fbError) {
        console.error('[vinyl/settings GET] Firebase error:', fbError);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      settings: settings || null,
      source
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[vinyl/settings GET] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Failed to fetch settings' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST - Save seller settings (D1 primary, Firebase backup)
export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  const env = (locals as any)?.runtime?.env || {};

  // Rate limit writes
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`vinyl-settings-write:${clientId}`, {
    maxRequests: 20,
    windowMs: 60 * 60 * 1000
  });

  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    // Verify authentication
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
    if (authError || !verifiedUserId) {
      return new Response(JSON.stringify({ success: false, error: 'Authentication required' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = await request.json();
    const { userId } = body;

    if (!userId) {
      return new Response(JSON.stringify({ success: false, error: 'User ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Verify user is updating their own settings
    if (verifiedUserId !== userId) {
      return new Response(JSON.stringify({ success: false, error: 'You can only update your own settings' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate and sanitize data
    const now = new Date().toISOString();
    const db = env.DB;

    // Check if user already has settings (to preserve collection number)
    let existingSettings = null;
    let collectionNumber = null;
    let isNewSeller = false;

    if (db) {
      try {
        existingSettings = await d1GetVinylSeller(db, userId);
        if (existingSettings?.collectionNumber) {
          collectionNumber = existingSettings.collectionNumber;
        } else {
          // New seller - assign next collection number
          collectionNumber = await d1GetNextCollectionNumber(db);
          isNewSeller = true;
          console.log('[vinyl/settings POST] Assigning collection number:', collectionNumber);
        }
      } catch (e) {
        console.error('[vinyl/settings POST] Error checking existing settings:', e);
      }
    }

    const settings: any = {
      userId,
      collectionNumber,
      // UK Shipping
      shippingSingle: Math.min(Math.max(parseFloat(body.shippingSingle) || 0, 0), MAX_SHIPPING),
      shippingAdditional: Math.min(Math.max(parseFloat(body.shippingAdditional) || 0, 0), MAX_SHIPPING),
      // International Shipping
      shipsInternational: !!body.shipsInternational,
      shippingEurope: Math.min(Math.max(parseFloat(body.shippingEurope) || 0, 0), MAX_SHIPPING),
      shippingEuropeAdditional: Math.min(Math.max(parseFloat(body.shippingEuropeAdditional) || 0, 0), MAX_SHIPPING),
      shippingWorldwide: Math.min(Math.max(parseFloat(body.shippingWorldwide) || 0, 0), MAX_SHIPPING),
      shippingWorldwideAdditional: Math.min(Math.max(parseFloat(body.shippingWorldwideAdditional) || 0, 0), MAX_SHIPPING),
      // Delivery options
      deliveryMethod: body.deliveryMethod || 'royal_mail_signed',
      estimatedDelivery: body.estimatedDelivery || '2-3',
      dispatchTime: body.dispatchTime || '1_day',
      // Store Info
      storeName: (body.storeName || '').trim().slice(0, MAX_STORE_NAME),
      location: (body.location || '').trim().slice(0, MAX_LOCATION),
      description: (body.description || '').trim().slice(0, MAX_DESCRIPTION),
      discogsUrl: (body.discogsUrl || '').trim().slice(0, 200),
      // Meta
      updatedAt: now,
      createdAt: existingSettings?.createdAt || body.createdAt || now
    };

    let d1Success = false;
    let firebaseSuccess = false;

    // Write to D1 first (primary)
    if (db) {
      try {
        d1Success = await d1UpsertVinylSeller(db, userId, settings);
        if (d1Success) {
          console.log('[vinyl/settings POST] Saved to D1:', userId);
        }
      } catch (d1Error) {
        console.error('[vinyl/settings POST] D1 error:', d1Error);
      }
    }

    // Write to Firebase as backup (non-blocking failure)
    try {
      const serviceAccountKey = getServiceAccountKey(env);
      const projectId = env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

      if (serviceAccountKey) {
        await saSetDocument(serviceAccountKey, projectId, 'vinyl-sellers', userId, settings);
        firebaseSuccess = true;
        console.log('[vinyl/settings POST] Saved to Firebase:', userId);
      } else {
        // Try client API as fallback
        await setDocument('vinyl-sellers', userId, settings);
        firebaseSuccess = true;
        console.log('[vinyl/settings POST] Saved to Firebase (client API):', userId);
      }
    } catch (fbError) {
      console.error('[vinyl/settings POST] Firebase backup failed (non-critical):', fbError);
    }

    // At least one storage must succeed
    if (!d1Success && !firebaseSuccess) {
      return new Response(JSON.stringify({ success: false, error: 'Failed to save settings' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Settings saved',
      collectionNumber: collectionNumber,
      isNewSeller: isNewSeller,
      storage: { d1: d1Success, firebase: firebaseSuccess }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[vinyl/settings POST] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
