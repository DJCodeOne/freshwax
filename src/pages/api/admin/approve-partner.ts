// /src/pages/api/admin/approve-partner.ts
// API endpoint to approve a partner

import type { APIRoute } from 'astro';
import { updateDocument, getDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

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

    const now = new Date().toISOString();

    // Get the artist document to check their roles
    const artistDoc = await getDocument('artists', partnerId);

    // Update artists collection
    await updateDocument('artists', partnerId, {
      approved: true,
      approvedAt: now,
      status: 'approved'
    });

    // Also update users collection for consistency
    const userDoc = await getDocument('users', partnerId);
    if (userDoc) {
      const existingRoles = userDoc.roles || {};
      await updateDocument('users', partnerId, {
        roles: {
          ...existingRoles,
          artist: existingRoles.artist || artistDoc?.isArtist || true,
          merchSupplier: existingRoles.merchSupplier || artistDoc?.isMerchSupplier || false
        },
        partnerInfo: {
          ...(userDoc.partnerInfo || {}),
          approved: true,
          approvedAt: now
        }
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Error approving partner:', error);
    return new Response(JSON.stringify({ error: 'Failed to approve partner' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};