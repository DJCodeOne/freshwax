// src/pages/api/admin/list-partners.ts
// Server-side endpoint to list partners (artists and merch suppliers)
// Uses firebase-rest.ts for Firestore access

import type { APIRoute } from 'astro';
import { getDocument, queryCollection } from '../../../lib/firebase-rest';
import { saQueryCollection } from '../../../lib/firebase-service-account';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

// Helper to initialize Firebase and admin config
function initServices(locals: any) {
  const env = locals?.runtime?.env || {};

  initAdminEnv({ ADMIN_UIDS: env.ADMIN_UIDS, ADMIN_EMAILS: env.ADMIN_EMAILS });
}

// Build service account query function for blocked collections
function getSaQuery(locals: any) {
  const env = locals?.runtime?.env || {};
  const projectId = env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = env.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;
  if (!clientEmail || !privateKey) return (c: string, o?: any) => queryCollection(c, o);
  const key = JSON.stringify({ type: 'service_account', project_id: projectId, private_key: privateKey.replace(/\\n/g, '\n'), client_email: clientEmail });
  return (c: string, o?: any) => saQueryCollection(key, projectId, c, o);
}

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`list-partners:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  // Initialize Firebase and admin config for Cloudflare runtime
  initServices(locals);

  // Verify admin authentication using secure admin key
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  try {
    const partners: any[] = [];

    // Load users collection (contains all user data after migration)
    // Uses service account to bypass Firestore rules for blocked collections
    const saQuery = getSaQuery(locals);
    const users = await saQuery('users', { cacheTime: 300000, limit: 500 });

    // Process users - only include those with artist, merch, or vinyl seller roles
    for (const user of users) {
      if (user.deleted === true) continue;

      const roles = user.roles || {};
      const isArtist = roles.artist === true;
      const isMerchSupplier = roles.merchSupplier === true || roles.merchSeller === true;
      const isVinylSeller = roles.vinylSeller === true;

      // Only include if they have artist, merch, or vinyl seller role
      if (!isArtist && !isMerchSupplier && !isVinylSeller) continue;

      partners.push({
        id: user.id,
        email: user.email || user.partnerInfo?.email || '',
        name: user.fullName || user.name || user.displayName || '',
        displayName: user.partnerInfo?.displayName || user.displayName || '',
        phone: user.phone || user.partnerInfo?.phone || '',
        avatarUrl: user.avatarUrl || user.photoURL || null,
        address: user.address1 ? {
          line1: user.address1,
          line2: user.address2,
          city: user.city,
          county: user.county,
          postcode: user.postcode,
          country: user.country
        } : (user.address || null),
        isAdmin: user.isAdmin || roles.admin || false,
        isCustomer: roles.customer !== false,
        isArtist: isArtist,
        isDJ: roles.dj !== false,
        isMerchSupplier: isMerchSupplier,
        isVinylSeller: isVinylSeller,
        isApproved: user.approved === true ||
                    user.partnerInfo?.approved === true ||
                    user.pendingRoles?.artist?.status === 'approved' ||
                    user.pendingRoles?.merchSeller?.status === 'approved' ||
                    user.pendingRoles?.vinylSeller?.status === 'approved',
        isDisabled: user.disabled === true || user.suspended === true,
        canBuy: user.permissions?.canBuy ?? true,
        canComment: user.permissions?.canComment ?? true,
        canRate: user.permissions?.canRate ?? true,
        createdAt: user.createdAt || user.registeredAt || null,
        source: 'users'
      });
    }

    // Sort by name
    partners.sort((a, b) => (a.displayName || a.name || '').localeCompare(b.displayName || b.name || ''));

    return new Response(JSON.stringify({
      success: true,
      partners,
      stats: {
        total: partners.length,
        artists: partners.filter(p => p.isArtist).length,
        merch: partners.filter(p => p.isMerchSupplier).length,
        vinyl: partners.filter(p => p.isVinylSeller).length,
        pending: partners.filter(p => !p.isApproved).length,
        approved: partners.filter(p => p.isApproved).length
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[list-partners] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch partners'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
