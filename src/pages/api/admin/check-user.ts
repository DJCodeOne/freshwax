// src/pages/api/admin/check-user.ts
// Check user data in Firebase

import type { APIRoute } from 'astro';
import { initFirebaseEnv, getDocument, queryCollection } from '../../../lib/firebase-rest';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  const email = url.searchParams.get('email');

  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    let user: any = null;

    if (userId) {
      user = await getDocument('users', userId);
      if (user) user.id = userId;
    } else if (email) {
      const users = await queryCollection('users', {
        filters: [{ field: 'email', op: 'EQUAL', value: email }],
        limit: 1
      });
      if (users.length > 0) user = users[0];
    }

    if (!user) {
      return new Response(JSON.stringify({ error: 'User not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check if they would appear in partners list
    const roles = user.roles || {};
    const isArtist = roles.artist === true;
    const isMerchSupplier = roles.merchSupplier === true || roles.merchSeller === true;
    const isVinylSeller = roles.vinylSeller === true;
    const wouldBeInPartners = isArtist || isMerchSupplier || isVinylSeller;

    return new Response(JSON.stringify({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        roles: user.roles,
      },
      analysis: {
        isArtist,
        isMerchSupplier,
        isVinylSeller,
        wouldBeInPartners,
        expectedLocation: wouldBeInPartners ? 'Partner Management' : 'User Management'
      }
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
