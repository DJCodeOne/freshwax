// src/pages/api/admin/list-partners.ts
// Server-side endpoint to list partners (artists and merch suppliers)
// Uses firebase-rest.ts for Firestore access

import type { APIRoute } from 'astro';
import { getDocument, queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';
import { isAdmin, initAdminEnv } from '../../../lib/admin';

export const prerender = false;

// Helper to initialize Firebase and admin config
function initServices(locals: any) {
  const env = locals?.runtime?.env || {};
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
  initAdminEnv({ ADMIN_UIDS: env.ADMIN_UIDS, ADMIN_EMAILS: env.ADMIN_EMAILS });
}

export const GET: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase and admin config for Cloudflare runtime
  initServices(locals);

  const url = new URL(request.url);
  const uid = url.searchParams.get('uid');
  
  if (!uid) {
    return new Response(JSON.stringify({ success: false, error: 'Missing uid' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Verify admin status
  const adminCheck = await isAdmin(uid);
  if (!adminCheck) {
    return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  try {
    const partners: any[] = [];

    // Load from both users and customers collections
    const [users, customers] = await Promise.all([
      queryCollection('users', { cacheTime: 300000, limit: 500 }),
      queryCollection('customers', { cacheTime: 300000, limit: 500 })
    ]);

    // Build customer lookup map for merging profile data
    const customerMap = new Map<string, any>();
    for (const customer of customers) {
      customerMap.set(customer.id, customer);
    }

    // Process users - only include those with artist, merch, or vinyl seller roles
    for (const user of users) {
      if (user.deleted === true) continue;

      const roles = user.roles || {};
      const isArtist = roles.artist === true;
      const isMerchSupplier = roles.merchSupplier === true || roles.merchSeller === true;
      const isVinylSeller = roles.vinylSeller === true;

      // Only include if they have artist, merch, or vinyl seller role
      if (!isArtist && !isMerchSupplier && !isVinylSeller) continue;

      // Merge with customer data for email/phone/name (customers collection has latest profile data)
      const customer = customerMap.get(user.id);

      partners.push({
        id: user.id,
        email: customer?.email || user.email || user.partnerInfo?.email || '',
        name: customer?.fullName || user.fullName || user.name || user.displayName || '',
        displayName: user.partnerInfo?.displayName || user.displayName || customer?.displayName || '',
        phone: customer?.phone || user.phone || user.partnerInfo?.phone || '',
        address: customer?.address1 ? {
          line1: customer.address1,
          line2: customer.address2,
          city: customer.city,
          county: customer.county,
          postcode: customer.postcode,
          country: customer.country
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
      error: 'Failed to fetch partners',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
