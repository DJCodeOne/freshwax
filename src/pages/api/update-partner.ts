// src/pages/api/update-partner.ts
// API endpoint to update partner/artist profile and settings
// Uses service account for writes to ensure Firebase security rules don't block

import type { APIRoute } from 'astro';
import { getDocument, verifyRequestUser } from '../../lib/firebase-rest';
import { saUpdateDocument } from '../../lib/firebase-service-account';
import { ApiErrors } from '../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

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
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`update-partner:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    // Get runtime env
    const env = locals.runtime.env || {};

    // SECURITY: Verify Firebase token instead of trusting cookies
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
    if (authError || !verifiedUserId) {
      return ApiErrors.unauthorized('Authentication required');
    }

    const data = await request.json();
    const { id, ...updateFields } = data;
    const partnerId = verifiedUserId;

    if (id !== partnerId) {
      return ApiErrors.forbidden('Not authorized to update this profile');
    }
    
    // Get partner document
    const partnerData = await getDocument('artists', partnerId);

    if (!partnerData) {
      return ApiErrors.notFound('Partner not found');
    }
    
    // Build clean update object (only allowed fields)
    const allowedFields = [
      'artistName', 'bio',
      'avatarUrl', 'bannerUrl', 'location', 'genres'
    ];
    
    const cleanData: Record<string, any> = {
      updatedAt: new Date().toISOString()
    };
    
    for (const field of allowedFields) {
      if (updateFields[field] !== undefined) {
        cleanData[field] = updateFields[field];
      }
    }
    
    // Validate specific fields
    if (cleanData.bio && cleanData.bio.length > 200) {
      cleanData.bio = cleanData.bio.slice(0, 200);
    }
    
    if (cleanData.artistName && cleanData.artistName.length > 50) {
      cleanData.artistName = cleanData.artistName.slice(0, 50);
    }

    // Get service account key for writes
    const serviceAccountKey = getServiceAccountKey(env);
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      console.error('[update-partner] Service account not configured');
      return ApiErrors.serverError('Service account not configured');
    }

    // Use service account for the write operation
    await saUpdateDocument(serviceAccountKey, projectId, 'artists', partnerId, cleanData);

    return new Response(JSON.stringify({
      success: true,
      message: 'Profile updated successfully'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error: unknown) {
    console.error('Error updating partner:', error);
    return ApiErrors.serverError('Failed to update profile');
  }
};
