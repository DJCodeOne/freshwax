// src/pages/api/admin/vinyl-listings.ts
// Admin API for managing vinyl listing approvals

import type { APIRoute } from 'astro';
import { initFirebaseEnv } from '../../../lib/firebase-rest';
import { saQueryCollection, saUpdateDocument, saGetDocument } from '../../../lib/firebase-service-account';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../../lib/rate-limit';

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

// Initialize Firebase from env
function initFirebase(locals: any) {
  const env = locals?.runtime?.env || {};
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

// GET - Fetch pending vinyl listings for admin review
export const GET: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  const env = (locals as any)?.runtime?.env || {};

  // Rate limit
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`admin-vinyl-read:${clientId}`, {
    maxRequests: 60,
    windowMs: 60 * 1000
  });

  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const serviceAccountKey = getServiceAccountKey(env);
    const projectId = env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      return new Response(JSON.stringify({ success: false, error: 'Service account not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Query pending vinyl listings
    const listings = await saQueryCollection(serviceAccountKey, projectId, 'vinylListings', {
      filters: [
        { field: 'status', op: 'EQUAL', value: 'pending' }
      ],
      orderBy: { field: 'submittedAt', direction: 'DESCENDING' },
      limit: 50
    });

    console.log('[admin/vinyl-listings GET] Found', listings.length, 'pending listings');

    return new Response(JSON.stringify({
      success: true,
      listings: listings || [],
      count: listings.length
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[admin/vinyl-listings GET] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Failed to fetch listings' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST - Approve or reject vinyl listing
export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  const env = (locals as any)?.runtime?.env || {};

  // Rate limit writes
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`admin-vinyl-write:${clientId}`, {
    maxRequests: 30,
    windowMs: 60 * 60 * 1000
  });

  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const body = await request.json();
    const { action, listingId } = body;

    if (!listingId) {
      return new Response(JSON.stringify({ success: false, error: 'Listing ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!['approve', 'reject'].includes(action)) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid action (approve or reject)' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const serviceAccountKey = getServiceAccountKey(env);
    const projectId = env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      return new Response(JSON.stringify({ success: false, error: 'Service account not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get the listing first
    const listing = await saGetDocument(serviceAccountKey, projectId, 'vinylListings', listingId);
    if (!listing) {
      return new Response(JSON.stringify({ success: false, error: 'Listing not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const now = new Date().toISOString();
    let updateData: any;

    if (action === 'approve') {
      updateData = {
        status: 'published',
        approvedAt: now,
        updatedAt: now
      };
      console.log('[admin/vinyl-listings POST] Approved listing:', listingId);
    } else {
      updateData = {
        status: 'rejected',
        rejectedAt: now,
        updatedAt: now
      };
      console.log('[admin/vinyl-listings POST] Rejected listing:', listingId);
    }

    await saUpdateDocument(serviceAccountKey, projectId, 'vinylListings', listingId, updateData);

    return new Response(JSON.stringify({
      success: true,
      message: `Listing ${action === 'approve' ? 'approved' : 'rejected'}`,
      listingId
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[admin/vinyl-listings POST] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
