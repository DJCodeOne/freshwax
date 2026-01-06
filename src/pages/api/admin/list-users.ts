// src/pages/api/admin/list-users.ts
// Server-side API to list users for admin dashboard
// Uses Firebase REST API to bypass Firestore rules

import type { APIRoute } from 'astro';
import { queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

// Helper to initialize Firebase for Cloudflare runtime
function initFirebase(locals: any) {
  const env = locals?.runtime?.env || {};
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

interface UserData {
  id: string;
  collection: string;
  displayName: string;
  fullName: string;
  email: string;
  phone: string;
  address: any;
  avatarUrl: string | null;
  roles: {
    customer: boolean;
    dj: boolean;
    artist: boolean;
    merch: boolean;
    vinylSeller: boolean;
  };
  isAdmin: boolean;
  permissions: any;
  approved: boolean;
  suspended: boolean;
  notes: string;
  registeredAt: string | null;
  orderCount: number;
  totalSpent: number;
  source: string;
}

export const GET: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`list-users:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  // Initialize Firebase for Cloudflare runtime
  initFirebase(locals);

  try {
    // SECURITY: Require admin authentication via admin key (not spoofable UID)
    // For GET requests, check X-Admin-Key header
    const authError = requireAdminAuth(request, locals);
    if (authError) return authError;

    // Pagination params - SECURITY: No UID from query params (appears in logs)
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
    const search = url.searchParams.get('search')?.toLowerCase() || '';
    const roleFilter = url.searchParams.get('role') || 'all'; // all, customer, dj, artist, merch

    // Load users collection as SOURCE OF TRUTH + orders for stats
    const usersMap = new Map<string, UserData>();

    // Load users collection (source of truth) and orders in parallel
    // 3 min cache for users - admin data doesn't need real-time updates
    const [users, orders] = await Promise.all([
      queryCollection('users', { limit: 500, cacheTime: 180000 }), // 3 min cache
      queryCollection('orders', { limit: 500, cacheTime: 180000 }) // 3 min cache for orders
    ]);

    // Process users collection - this is the SOURCE OF TRUTH
    for (const doc of users) {
      if (doc.deleted === true) continue;

      // Get roles from the roles object (primary) or legacy fields
      const roles = doc.roles || {};

      usersMap.set(doc.id, {
        id: doc.id,
        collection: 'users',
        displayName: doc.displayName || doc.name || doc.fullName || 'Unknown',
        fullName: doc.fullName || doc.name || '',
        email: doc.email || '',
        phone: doc.phone || '',
        address: doc.address || null,
        avatarUrl: doc.avatarUrl || doc.photoURL || null,
        roles: {
          customer: roles.customer !== false, // default true
          dj: roles.dj !== false, // default true (all users are DJs)
          artist: roles.artist === true,
          merch: roles.merchSupplier === true || roles.merchSeller === true,
          vinylSeller: roles.vinylSeller === true
        },
        isAdmin: doc.isAdmin === true || roles.admin === true,
        permissions: doc.permissions || { canBuy: true, canComment: true, canRate: true },
        approved: doc.approved === true || (doc.partnerInfo?.approved === true),
        suspended: doc.suspended === true || doc.disabled === true,
        notes: doc.adminNotes || '',
        registeredAt: doc.createdAt || doc.registeredAt || null,
        orderCount: 0,
        totalSpent: 0,
        source: 'users'
      });
    }

    // Process order data
    const ordersByUser = new Map<string, { count: number; total: number }>();
    for (const order of orders) {
      const userId = order.userId || order.customerId;
      if (!userId) continue;

      if (!ordersByUser.has(userId)) {
        ordersByUser.set(userId, { count: 0, total: 0 });
      }
      const userOrders = ordersByUser.get(userId)!;
      userOrders.count++;
      userOrders.total += order.total || order.totalAmount || 0;
    }

    // Merge order data
    for (const [userId, orderData] of ordersByUser) {
      const user = usersMap.get(userId);
      if (user) {
        user.orderCount = orderData.count;
        user.totalSpent = orderData.total;
      }
    }

    // Convert to array and sort by registeredAt desc
    let allUsers = Array.from(usersMap.values());
    allUsers.sort((a, b) => {
      const dateA = a.registeredAt ? new Date(a.registeredAt).getTime() : 0;
      const dateB = b.registeredAt ? new Date(b.registeredAt).getTime() : 0;
      return dateB - dateA;
    });

    // Apply search filter
    if (search) {
      allUsers = allUsers.filter(u =>
        u.displayName?.toLowerCase().includes(search) ||
        u.email?.toLowerCase().includes(search) ||
        u.fullName?.toLowerCase().includes(search)
      );
    }

    // Filter OUT users with partner roles - they belong in Partner Management
    // User Management is only for Customers and DJs (non-partner roles)
    allUsers = allUsers.filter(u => !u.roles.artist && !u.roles.merch && !u.roles.vinylSeller);

    // Apply role filter
    if (roleFilter !== 'all') {
      allUsers = allUsers.filter(u => {
        switch (roleFilter) {
          case 'customer': return u.roles.customer && !u.roles.dj;
          case 'dj': return u.roles.dj;
          default: return true;
        }
      });
    }

    // Calculate stats (before pagination) - artists/merch already filtered out
    const totalCount = allUsers.length;
    const customerCount = allUsers.filter(u => u.roles.customer && !u.roles.dj).length;
    const djCount = allUsers.filter(u => u.roles.dj).length;
    const totalRevenue = allUsers.reduce((sum, u) => sum + (u.totalSpent || 0), 0);

    // Apply pagination
    const startIndex = (page - 1) * limit;
    const paginatedUsers = allUsers.slice(startIndex, startIndex + limit);
    const totalPages = Math.ceil(totalCount / limit);

    return new Response(JSON.stringify({
      success: true,
      users: paginatedUsers,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages,
        hasMore: page < totalPages
      },
      stats: {
        totalCount,
        customerCount,
        djCount,
        totalRevenue
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[admin/list-users] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load users'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
