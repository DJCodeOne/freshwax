// src/pages/api/admin/list-users.ts
// Server-side API to list users for admin dashboard
// Uses Firebase REST API to bypass Firestore rules

import type { APIRoute } from 'astro';
import { queryCollection, getDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

// Helper to initialize Firebase for Cloudflare runtime
function initFirebase(locals: any) {
  const env = locals?.runtime?.env || {};
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY || 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g',
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

// Hardcoded admin UIDs for verification
const ADMIN_UIDS = ['Y3TGc171cHSWTqZDRSniyu7Jxc33', '8WmxYeCp4PSym5iWHahgizokn5F2'];
const ADMIN_EMAILS = ['freshwaxonline@gmail.com'];

async function isAdmin(uid: string): Promise<boolean> {
  if (ADMIN_UIDS.includes(uid)) return true;

  // Check admins collection
  const adminDoc = await getDocument('admins', uid);
  if (adminDoc) return true;

  // Check if user has admin role
  const userDoc = await getDocument('users', uid);
  if (userDoc?.isAdmin || userDoc?.roles?.admin) return true;

  return false;
}

export const GET: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  initFirebase(locals);

  try {
    // Get admin UID from header or query param
    const url = new URL(request.url);
    const adminUid = request.headers.get('x-admin-uid') || url.searchParams.get('uid');

    if (!adminUid) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Admin UID required'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    // Verify admin status
    const authorized = await isAdmin(adminUid);
    if (!authorized) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized - admin access required'
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    // Load users from all collections
    const usersMap = new Map<string, UserData>();

    // Load from customers collection
    const customers = await queryCollection('customers', {
      limit: 500,
      skipCache: true
    });

    for (const doc of customers) {
      usersMap.set(doc.id, {
        id: doc.id,
        collection: 'customers',
        displayName: doc.displayName || doc.name || doc.fullName || 'Unknown',
        fullName: doc.fullName || doc.name || '',
        email: doc.email || '',
        phone: doc.phone || '',
        address: doc.address || doc.shippingAddress || null,
        avatarUrl: doc.avatarUrl || doc.photoURL || null,
        roles: {
          customer: true,
          dj: doc.isDJ === true || doc.roles?.dj === true,
          artist: doc.isArtist === true || doc.roles?.artist === true,
          merch: doc.isMerchSupplier === true || doc.roles?.merchSupplier === true
        },
        isAdmin: doc.isAdmin === true || doc.roles?.admin === true,
        permissions: doc.permissions || { canBuy: true, canComment: true, canRate: true },
        approved: doc.approved === true,
        suspended: doc.suspended === true,
        notes: doc.adminNotes || '',
        registeredAt: doc.createdAt || doc.registeredAt || null,
        orderCount: 0,
        totalSpent: 0,
        source: 'customers'
      });
    }

    // Load from users collection
    const users = await queryCollection('users', {
      limit: 500,
      skipCache: true
    });

    for (const doc of users) {
      if (usersMap.has(doc.id)) {
        // Merge data
        const existing = usersMap.get(doc.id)!;
        existing.roles.dj = existing.roles.dj || doc.isDJ === true || doc.roles?.dj === true;
        existing.roles.artist = existing.roles.artist || doc.isArtist === true || doc.roles?.artist === true;
        existing.roles.merch = existing.roles.merch || doc.isMerchSupplier === true || doc.roles?.merchSupplier === true;
        existing.approved = existing.approved || doc.approved === true;
        existing.isAdmin = existing.isAdmin || doc.isAdmin === true || doc.roles?.admin === true;
        if (!existing.email && doc.email) existing.email = doc.email;
        if (!existing.phone && doc.phone) existing.phone = doc.phone;
        if (!existing.avatarUrl && (doc.avatarUrl || doc.photoURL)) existing.avatarUrl = doc.avatarUrl || doc.photoURL;
        if (doc.address) existing.address = doc.address;
        if (doc.permissions) existing.permissions = { ...existing.permissions, ...doc.permissions };
      } else {
        usersMap.set(doc.id, {
          id: doc.id,
          collection: 'users',
          displayName: doc.displayName || doc.name || 'Unknown',
          fullName: doc.fullName || doc.name || '',
          email: doc.email || '',
          phone: doc.phone || '',
          address: doc.address || null,
          avatarUrl: doc.avatarUrl || doc.photoURL || null,
          roles: {
            customer: true,
            dj: doc.isDJ === true || doc.roles?.dj === true,
            artist: doc.isArtist === true || doc.roles?.artist === true,
            merch: doc.isMerchSupplier === true || doc.roles?.merchSupplier === true
          },
          isAdmin: doc.isAdmin === true || doc.roles?.admin === true,
          permissions: doc.permissions || { canBuy: true, canComment: true, canRate: true },
          approved: doc.approved === true,
          suspended: doc.suspended === true,
          notes: doc.adminNotes || '',
          registeredAt: doc.createdAt || null,
          orderCount: 0,
          totalSpent: 0,
          source: 'users'
        });
      }
    }

    // Load from artists collection
    const artists = await queryCollection('artists', {
      limit: 500,
      skipCache: true
    });

    for (const doc of artists) {
      if (usersMap.has(doc.id)) {
        // Merge data
        const existing = usersMap.get(doc.id)!;
        existing.roles.artist = existing.roles.artist || doc.isArtist === true;
        existing.roles.merch = existing.roles.merch || doc.isMerchSupplier === true;
        existing.approved = existing.approved || doc.approved === true;
        existing.suspended = existing.suspended || doc.suspended === true;
        existing.notes = existing.notes || doc.adminNotes || '';
        if (!existing.email && doc.email) existing.email = doc.email;
        if (!existing.phone && (doc.phone || doc.whatsapp)) existing.phone = doc.phone || doc.whatsapp;
        if (!existing.avatarUrl && (doc.avatarUrl || doc.photoURL || doc.imageUrl)) {
          existing.avatarUrl = doc.avatarUrl || doc.photoURL || doc.imageUrl;
        }
      } else {
        usersMap.set(doc.id, {
          id: doc.id,
          collection: 'artists',
          displayName: doc.artistName || doc.name || 'Unknown',
          fullName: doc.name || doc.fullName || '',
          email: doc.email || '',
          phone: doc.phone || doc.whatsapp || '',
          address: null,
          avatarUrl: doc.avatarUrl || doc.photoURL || doc.imageUrl || null,
          roles: {
            customer: false,
            dj: false,
            artist: doc.isArtist === true,
            merch: doc.isMerchSupplier === true
          },
          isAdmin: false,
          permissions: { canBuy: true, canComment: true, canRate: true },
          approved: doc.approved === true,
          suspended: doc.suspended === true,
          notes: doc.adminNotes || '',
          registeredAt: doc.registeredAt || doc.createdAt || null,
          orderCount: 0,
          totalSpent: 0,
          source: 'artists'
        });
      }
    }

    // Load order data
    const orders = await queryCollection('orders', {
      limit: 1000,
      skipCache: true
    });

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
    const allUsers = Array.from(usersMap.values());
    allUsers.sort((a, b) => {
      const dateA = a.registeredAt ? new Date(a.registeredAt).getTime() : 0;
      const dateB = b.registeredAt ? new Date(b.registeredAt).getTime() : 0;
      return dateB - dateA;
    });

    // Calculate stats
    const usersToShow = allUsers.filter(u => !u.roles.artist && !u.roles.merch && (u.roles.customer || u.roles.dj));
    const totalCount = usersToShow.length;
    const customerCount = usersToShow.filter(u => u.roles.customer && !u.roles.dj).length;
    const djCount = usersToShow.filter(u => u.roles.dj).length;
    const totalRevenue = usersToShow.reduce((sum, u) => sum + (u.totalSpent || 0), 0);

    return new Response(JSON.stringify({
      success: true,
      users: allUsers,
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
