// src/pages/api/profile-sync.ts
// Sync profile data from customers collection to users collection
// Called when user updates their profile in account dashboard

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, initFirebaseEnv } from '../../lib/firebase-rest';

export const prerender = false;

// Helper to initialize Firebase for Cloudflare runtime
function initFirebase(locals: any) {
  const env = locals?.runtime?.env || {};
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);

  try {
    const body = await request.json();
    const { userId, displayName, phone, firstName, lastName, email } = body;

    if (!userId) {
      return new Response(JSON.stringify({ success: false, error: 'Missing userId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check if user exists in users collection
    const userDoc = await getDocument('users', userId);
    if (!userDoc) {
      return new Response(JSON.stringify({ success: false, error: 'User not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Build update object - sync key profile fields to users collection
    const updateData: any = {
      updatedAt: new Date().toISOString()
    };

    // Update top-level fields
    // Note: email is immutable - not synced to users collection (customers is source of truth)
    if (displayName !== undefined) updateData.displayName = displayName;
    if (phone !== undefined) updateData.phone = phone;
    if (firstName !== undefined) updateData.name = `${firstName} ${lastName || ''}`.trim();

    // Update partnerInfo for partner dashboard
    if (displayName !== undefined) updateData['partnerInfo.displayName'] = displayName;
    if (phone !== undefined) updateData['partnerInfo.phone'] = phone;
    if (firstName !== undefined) {
      updateData['partnerInfo.firstName'] = firstName;
      updateData['partnerInfo.lastName'] = lastName || '';
    }

    await updateDocument('users', userId, updateData);

    return new Response(JSON.stringify({ success: true, message: 'Profile synced' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[profile-sync] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to sync profile'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
