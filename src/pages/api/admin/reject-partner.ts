// /src/pages/api/admin/reject-partner.ts
// API endpoint to reject (delete) a partner application

import type { APIRoute } from 'astro';
import { deleteDocument, getDocument, updateDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

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

    // Delete partner document from artists collection
    await deleteDocument('artists', partnerId);

    // Also update users collection to remove partner roles
    const userDoc = await getDocument('users', partnerId);
    if (userDoc) {
      const existingRoles = userDoc.roles || {};
      await updateDocument('users', partnerId, {
        roles: {
          ...existingRoles,
          artist: false,
          merchSupplier: false
        },
        partnerInfo: {
          ...(userDoc.partnerInfo || {}),
          approved: false,
          rejectedAt: new Date().toISOString()
        }
      });
    }

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