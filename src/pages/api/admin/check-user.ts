// src/pages/api/admin/check-user.ts
// Check user data in Firebase

import type { APIRoute } from 'astro';
import { getDocument, queryCollection } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { getSaQuery } from '../../../lib/admin-query';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`check-user:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  // Require admin authentication
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  const email = url.searchParams.get('email');

  const env = locals.runtime.env;

  const saQuery = getSaQuery(locals);

  try {
    let user: any = null;

    if (userId) {
      user = await getDocument('users', userId);
      if (user) user.id = userId;
    } else if (email) {
      const users = await saQuery('users', {
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

    // Also fetch usage data
    const usageDoc = await getDocument('userUsage', user.id);

    return new Response(JSON.stringify({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        roles: user.roles,
        subscription: user.subscription || null,
        isAdmin: user.isAdmin || false,
      },
      usage: usageDoc || null,
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
      error: 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
