// src/pages/api/update-partner.ts
// API endpoint to update partner/artist profile and settings
// Uses service account for writes to ensure Firebase security rules don't block

import type { APIRoute } from 'astro';
import { getDocument, initFirebaseEnv } from '../../lib/firebase-rest';
import { saUpdateDocument } from '../../lib/firebase-service-account';

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

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  try {
    const data = await request.json();
    const { id, ...updateFields } = data;

    // Get runtime env
    const env = (locals as any)?.runtime?.env || {};

    // Initialize Firebase for reads
    initFirebaseEnv({
      FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
      FIREBASE_API_KEY: env.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
    });

    // Verify the user is updating their own profile
    const partnerId = cookies.get('partnerId')?.value || '';
    
    if (!partnerId) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Not authenticated' 
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (id !== partnerId) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Not authorized' 
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Get partner document
    const partnerData = await getDocument('artists', partnerId);

    if (!partnerData) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Partner not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
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
      return new Response(JSON.stringify({
        success: false,
        error: 'Service account not configured'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
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
    
  } catch (error) {
    console.error('Error updating partner:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Failed to update profile' 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
