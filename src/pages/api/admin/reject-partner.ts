// /src/pages/api/admin/reject-partner.ts
// API endpoint to reject (delete) a partner application

import type { APIRoute } from 'astro';
import { deleteDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const { partnerId } = await request.json();

    if (!partnerId) {
      return new Response(JSON.stringify({ error: 'Partner ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Delete partner document
    await deleteDocument('artists', partnerId);

    // TODO: Optionally send rejection email
    // Be mindful of how you communicate rejections

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Error rejecting partner:', error);
    return new Response(JSON.stringify({ error: 'Failed to reject partner' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};