// Fresh Wax API Worker - Main Entry Point
// Cloudflare Worker handling all backend operations with Firebase Admin access

import type { Env, ApiResponse } from './types';
import {
  getPendingRequests,
  requestRole,
  approveRole,
  denyRole,
  revokeRole,
  getUserRoles
} from './routes/roles';
import {
  getDocument,
  setDocument,
  updateDocument,
  deleteDocument,
  queryCollection
} from './services/firebase';

// CORS headers
function corsHeaders(origin: string, env: Env): HeadersInit {
  const allowedOrigins = env.CORS_ORIGIN.split(',').map(o => o.trim());
  const isAllowed = allowedOrigins.includes(origin) || allowedOrigins.includes('*');

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowedOrigins[0],
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key, X-User-Id',
    'Access-Control-Max-Age': '86400'
  };
}

// JSON response helper
function jsonResponse<T>(data: ApiResponse<T>, status: number, origin: string, env: Env): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin, env)
    }
  });
}

// Extract path and query from URL
function parseUrl(url: string): { path: string; query: URLSearchParams } {
  const urlObj = new URL(url);
  return {
    path: urlObj.pathname,
    query: urlObj.searchParams
  };
}

// Verify admin authorization
function verifyAdmin(request: Request, env: Env): { valid: boolean; adminUid?: string } {
  const adminKey = request.headers.get('X-Admin-Key');
  if (adminKey === env.ADMIN_SECRET_KEY) {
    // Admin key auth - use header UID or default admin
    const uid = request.headers.get('X-User-Id') || 'Y3TGc171cHSWTqZDRSniyu7Jxc33';
    return { valid: true, adminUid: uid };
  }
  return { valid: false };
}

// Get user ID from request
function getUserId(request: Request): string | null {
  return request.headers.get('X-User-Id');
}

// Main request handler
async function handleRequest(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin') || '*';
  const { path, query } = parseUrl(request.url);
  const method = request.method;

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(origin, env)
    });
  }

  try {
    // ============================================
    // HEALTH CHECK
    // ============================================
    if (path === '/health' || path === '/') {
      return jsonResponse({
        success: true,
        data: {
          status: 'healthy',
          version: '1.0.0',
          environment: env.ENVIRONMENT
        }
      }, 200, origin, env);
    }

    // ============================================
    // ROLE MANAGEMENT ROUTES
    // ============================================

    // GET /roles/pending - Get all pending role requests (admin only)
    if (path === '/roles/pending' && method === 'GET') {
      const auth = verifyAdmin(request, env);
      if (!auth.valid) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 403, origin, env);
      }

      const result = await getPendingRequests(env, auth.adminUid!);
      return jsonResponse(result, result.success ? 200 : (result.status || 500), origin, env);
    }

    // POST /roles/request - Request a new role
    if (path === '/roles/request' && method === 'POST') {
      const userId = getUserId(request);
      if (!userId) {
        return jsonResponse({ success: false, error: 'User ID required' }, 401, origin, env);
      }

      const body = await request.json() as {
        roleType: 'artist' | 'merchSeller' | 'djBypass';
        artistName?: string;
        bio?: string;
        links?: string;
        businessName?: string;
        description?: string;
        website?: string;
        reason?: string;
      };

      const result = await requestRole(env, userId, body.roleType, body);
      return jsonResponse(result, result.success ? 200 : (result.status || 500), origin, env);
    }

    // POST /roles/approve - Approve a role request (admin only)
    if (path === '/roles/approve' && method === 'POST') {
      const auth = verifyAdmin(request, env);
      if (!auth.valid) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 403, origin, env);
      }

      const body = await request.json() as {
        uid: string;
        roleType: 'artist' | 'merchSeller' | 'djBypass';
      };

      const result = await approveRole(env, auth.adminUid!, body.uid, body.roleType);
      return jsonResponse(result, result.success ? 200 : (result.status || 500), origin, env);
    }

    // POST /roles/deny - Deny a role request (admin only)
    if (path === '/roles/deny' && method === 'POST') {
      const auth = verifyAdmin(request, env);
      if (!auth.valid) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 403, origin, env);
      }

      const body = await request.json() as {
        uid: string;
        roleType: 'artist' | 'merchSeller' | 'djBypass';
        reason?: string;
      };

      const result = await denyRole(env, auth.adminUid!, body.uid, body.roleType, body.reason);
      return jsonResponse(result, result.success ? 200 : (result.status || 500), origin, env);
    }

    // POST /roles/revoke - Revoke a role (admin only)
    if (path === '/roles/revoke' && method === 'POST') {
      const auth = verifyAdmin(request, env);
      if (!auth.valid) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 403, origin, env);
      }

      const body = await request.json() as {
        uid: string;
        roleType: 'artist' | 'merchSeller' | 'djBypass';
      };

      const result = await revokeRole(env, auth.adminUid!, body.uid, body.roleType);
      return jsonResponse(result, result.success ? 200 : (result.status || 500), origin, env);
    }

    // GET /roles/user/:uid - Get user roles
    if (path.startsWith('/roles/user/') && method === 'GET') {
      const uid = path.split('/')[3];
      if (!uid) {
        return jsonResponse({ success: false, error: 'User ID required' }, 400, origin, env);
      }

      const result = await getUserRoles(env, uid);
      return jsonResponse(result, result.success ? 200 : (result.status || 500), origin, env);
    }

    // ============================================
    // USER ROUTES
    // ============================================

    // GET /users/:uid - Get user by ID
    if (path.startsWith('/users/') && method === 'GET') {
      const uid = path.split('/')[2];
      if (!uid) {
        return jsonResponse({ success: false, error: 'User ID required' }, 400, origin, env);
      }

      const user = await getDocument(env, 'users', uid);
      if (!user) {
        return jsonResponse({ success: false, error: 'User not found' }, 404, origin, env);
      }

      return jsonResponse({ success: true, data: user }, 200, origin, env);
    }

    // PUT /users/:uid - Update user
    if (path.startsWith('/users/') && method === 'PUT') {
      const uid = path.split('/')[2];
      const requestingUid = getUserId(request);

      // Must be the user themselves or an admin
      const auth = verifyAdmin(request, env);
      if (!auth.valid && requestingUid !== uid) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 403, origin, env);
      }

      const body = await request.json() as Record<string, any>;
      // Don't allow updating sensitive fields directly
      delete body.roles;
      delete body.pendingRoles;
      delete body.id;
      delete body.uid;

      const updated = await updateDocument(env, 'users', uid, {
        ...body,
        updatedAt: new Date().toISOString()
      });

      return jsonResponse({ success: true, data: updated }, 200, origin, env);
    }

    // ============================================
    // ARTIST ROUTES
    // ============================================

    // GET /artists - List all approved artists
    if (path === '/artists' && method === 'GET') {
      const artists = await queryCollection(env, 'artists', {
        filters: [{ field: 'approved', op: 'EQUAL', value: true }]
      });

      return jsonResponse({ success: true, data: artists }, 200, origin, env);
    }

    // GET /artists/:id - Get artist by ID
    if (path.startsWith('/artists/') && method === 'GET') {
      const id = path.split('/')[2];
      if (!id) {
        return jsonResponse({ success: false, error: 'Artist ID required' }, 400, origin, env);
      }

      const artist = await getDocument(env, 'artists', id);
      if (!artist) {
        return jsonResponse({ success: false, error: 'Artist not found' }, 404, origin, env);
      }

      return jsonResponse({ success: true, data: artist }, 200, origin, env);
    }

    // PUT /artists/:id - Update artist
    if (path.startsWith('/artists/') && method === 'PUT') {
      const id = path.split('/')[2];
      const requestingUid = getUserId(request);

      // Must be the artist themselves or an admin
      const auth = verifyAdmin(request, env);
      const artist = await getDocument(env, 'artists', id);

      if (!artist) {
        return jsonResponse({ success: false, error: 'Artist not found' }, 404, origin, env);
      }

      if (!auth.valid && artist.userId !== requestingUid) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 403, origin, env);
      }

      const body = await request.json() as Record<string, any>;
      // Don't allow updating sensitive fields
      delete body.approved;
      delete body.suspended;
      delete body.id;
      delete body.userId;

      const updated = await updateDocument(env, 'artists', id, {
        ...body,
        updatedAt: new Date().toISOString()
      });

      return jsonResponse({ success: true, data: updated }, 200, origin, env);
    }

    // ============================================
    // CUSTOMER ROUTES
    // ============================================

    // GET /customers/:uid - Get customer by ID
    if (path.startsWith('/customers/') && method === 'GET') {
      const uid = path.split('/')[2];
      const requestingUid = getUserId(request);

      // Must be the customer themselves or an admin
      const auth = verifyAdmin(request, env);
      if (!auth.valid && requestingUid !== uid) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 403, origin, env);
      }

      const customer = await getDocument(env, 'customers', uid);
      if (!customer) {
        return jsonResponse({ success: false, error: 'Customer not found' }, 404, origin, env);
      }

      return jsonResponse({ success: true, data: customer }, 200, origin, env);
    }

    // PUT /customers/:uid - Update customer
    if (path.startsWith('/customers/') && method === 'PUT') {
      const uid = path.split('/')[2];
      const requestingUid = getUserId(request);

      // Must be the customer themselves or an admin
      const auth = verifyAdmin(request, env);
      if (!auth.valid && requestingUid !== uid) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 403, origin, env);
      }

      const body = await request.json() as Record<string, any>;
      // Don't allow updating sensitive fields
      delete body.id;
      delete body.uid;
      delete body.roles;

      const updated = await updateDocument(env, 'customers', uid, {
        ...body,
        updatedAt: new Date().toISOString()
      });

      return jsonResponse({ success: true, data: updated }, 200, origin, env);
    }

    // ============================================
    // ADMIN ROUTES
    // ============================================

    // GET /admin/users - List all users (admin only)
    if (path === '/admin/users' && method === 'GET') {
      const auth = verifyAdmin(request, env);
      if (!auth.valid) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 403, origin, env);
      }

      const limit = parseInt(query.get('limit') || '50');
      const users = await queryCollection(env, 'users', { limit });

      return jsonResponse({ success: true, data: users }, 200, origin, env);
    }

    // GET /admin/artists - List all artists (admin only)
    if (path === '/admin/artists' && method === 'GET') {
      const auth = verifyAdmin(request, env);
      if (!auth.valid) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 403, origin, env);
      }

      const artists = await queryCollection(env, 'artists');
      return jsonResponse({ success: true, data: artists }, 200, origin, env);
    }

    // GET /admin/customers - List all customers (admin only)
    if (path === '/admin/customers' && method === 'GET') {
      const auth = verifyAdmin(request, env);
      if (!auth.valid) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 403, origin, env);
      }

      const limit = parseInt(query.get('limit') || '50');
      const customers = await queryCollection(env, 'customers', { limit });

      return jsonResponse({ success: true, data: customers }, 200, origin, env);
    }

    // POST /admin/sync-user - Sync user data across collections (admin only)
    if (path === '/admin/sync-user' && method === 'POST') {
      const auth = verifyAdmin(request, env);
      if (!auth.valid) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 403, origin, env);
      }

      const body = await request.json() as { uid: string };
      const user = await getDocument(env, 'users', body.uid);

      if (!user) {
        return jsonResponse({ success: false, error: 'User not found' }, 404, origin, env);
      }

      // Ensure customer document exists
      const existingCustomer = await getDocument(env, 'customers', body.uid);
      if (!existingCustomer) {
        await setDocument(env, 'customers', body.uid, {
          uid: body.uid,
          email: user.email || '',
          displayName: user.displayName || '',
          roles: user.roles || {},
          createdAt: user.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }

      // If user has artist/merchSeller role, ensure artist document exists
      if (user.roles?.artist || user.roles?.merchSeller) {
        const existingArtist = await getDocument(env, 'artists', body.uid);
        if (!existingArtist) {
          await setDocument(env, 'artists', body.uid, {
            id: body.uid,
            userId: body.uid,
            artistName: user.displayName || '',
            displayName: user.displayName || '',
            email: user.email || '',
            isArtist: user.roles?.artist || false,
            isMerchSupplier: user.roles?.merchSeller || false,
            approved: true,
            suspended: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }
      }

      return jsonResponse({ success: true, message: 'User synced' }, 200, origin, env);
    }

    // POST /admin/set-role - Directly set a user role (admin only)
    if (path === '/admin/set-role' && method === 'POST') {
      const auth = verifyAdmin(request, env);
      if (!auth.valid) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 403, origin, env);
      }

      const body = await request.json() as {
        uid: string;
        role: 'artist' | 'merchSeller' | 'djEligible' | 'customer';
        value: boolean;
      };

      await updateDocument(env, 'users', body.uid, {
        [`roles.${body.role}`]: body.value,
        updatedAt: new Date().toISOString()
      });

      return jsonResponse({ success: true, message: `Role ${body.role} set to ${body.value}` }, 200, origin, env);
    }

    // ============================================
    // RELEASE MANAGEMENT ROUTES
    // ============================================

    // GET /releases - List all releases (with optional status filter)
    if (path === '/releases' && method === 'GET') {
      const status = query.get('status');
      const options: any = {};

      if (status) {
        options.filters = [{ field: 'status', op: 'EQUAL', value: status }];
      }

      const releases = await queryCollection(env, 'releases', options);
      return jsonResponse({ success: true, data: releases, count: releases.length }, 200, origin, env);
    }

    // GET /releases/:id - Get a specific release
    if (path.startsWith('/releases/') && !path.includes('/approve') && !path.includes('/reject') && method === 'GET') {
      const id = path.split('/')[2];
      const release = await getDocument(env, 'releases', id);

      if (!release) {
        return jsonResponse({ success: false, error: 'Release not found' }, 404, origin, env);
      }

      return jsonResponse({ success: true, data: release }, 200, origin, env);
    }

    // POST /releases/approve - Approve a release (admin only)
    if (path === '/releases/approve' && method === 'POST') {
      const auth = verifyAdmin(request, env);
      if (!auth.valid) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 403, origin, env);
      }

      const body = await request.json() as { releaseId: string };
      const release = await getDocument(env, 'releases', body.releaseId);

      if (!release) {
        return jsonResponse({ success: false, error: 'Release not found' }, 404, origin, env);
      }

      await updateDocument(env, 'releases', body.releaseId, {
        status: 'live',
        published: true,
        approvedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      console.log(`[releases] Approved: ${release.artistName} - ${release.releaseName}`);

      return jsonResponse({
        success: true,
        message: 'Release approved',
        releaseId: body.releaseId,
        artistName: release.artistName,
        releaseName: release.releaseName
      }, 200, origin, env);
    }

    // POST /releases/reject - Reject a release (admin only)
    if (path === '/releases/reject' && method === 'POST') {
      const auth = verifyAdmin(request, env);
      if (!auth.valid) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 403, origin, env);
      }

      const body = await request.json() as { releaseId: string; reason?: string };
      const release = await getDocument(env, 'releases', body.releaseId);

      if (!release) {
        return jsonResponse({ success: false, error: 'Release not found' }, 404, origin, env);
      }

      await updateDocument(env, 'releases', body.releaseId, {
        status: 'rejected',
        published: false,
        rejectedAt: new Date().toISOString(),
        rejectionReason: body.reason || '',
        updatedAt: new Date().toISOString()
      });

      console.log(`[releases] Rejected: ${release.artistName} - ${release.releaseName}`);

      return jsonResponse({
        success: true,
        message: 'Release rejected',
        releaseId: body.releaseId
      }, 200, origin, env);
    }

    // POST /admin/releases/create - Create a test release (admin only)
    if (path === '/admin/releases/create' && method === 'POST') {
      const auth = verifyAdmin(request, env);
      if (!auth.valid) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 403, origin, env);
      }

      const body = await request.json() as {
        artistName: string;
        releaseName: string;
        artistId?: string;
        status?: string;
        coverArtUrl?: string;
        tracks?: any[];
      };

      const releaseId = `${body.artistName.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`;

      const releaseData = {
        id: releaseId,
        artistName: body.artistName,
        artist: body.artistName,
        releaseName: body.releaseName,
        title: body.releaseName,
        artistId: body.artistId || '',
        status: body.status || 'pending',
        published: false,
        releaseType: 'Single',
        coverArtUrl: body.coverArtUrl || 'https://cdn.freshwax.co.uk/placeholder.jpg',
        tracks: body.tracks || [],
        createdAt: new Date().toISOString(),
        uploadedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await setDocument(env, 'releases', releaseId, releaseData);

      console.log(`[releases] Created: ${body.artistName} - ${body.releaseName} (${releaseId})`);

      return jsonResponse({
        success: true,
        message: 'Release created',
        releaseId,
        data: releaseData
      }, 200, origin, env);
    }

    // DELETE /admin/releases/:id - Delete a release (admin only)
    if (path.startsWith('/admin/releases/') && method === 'DELETE') {
      const auth = verifyAdmin(request, env);
      if (!auth.valid) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 403, origin, env);
      }

      const id = path.split('/')[3];
      await deleteDocument(env, 'releases', id);

      return jsonResponse({ success: true, message: 'Release deleted' }, 200, origin, env);
    }

    // ============================================
    // DJ MIXES ROUTES (collection: dj-mixes)
    // ============================================

    // GET /mixes - List all DJ mixes
    if (path === '/mixes' && method === 'GET') {
      const published = query.get('published');
      const options: any = {};

      if (published === 'true') {
        options.filters = [{ field: 'published', op: 'EQUAL', value: true }];
      }

      const mixes = await queryCollection(env, 'dj-mixes', options);
      return jsonResponse({ success: true, data: mixes, count: mixes.length }, 200, origin, env);
    }

    // GET /mixes/:id - Get a specific mix
    if (path.startsWith('/mixes/') && method === 'GET') {
      const id = path.split('/')[2];
      const mix = await getDocument(env, 'dj-mixes', id);

      if (!mix) {
        return jsonResponse({ success: false, error: 'Mix not found' }, 404, origin, env);
      }

      return jsonResponse({ success: true, data: mix }, 200, origin, env);
    }

    // ============================================
    // CART / RECORD BAG ROUTES
    // ============================================

    // GET /carts - List all carts (admin only)
    if (path === '/carts' && method === 'GET') {
      const auth = verifyAdmin(request, env);
      if (!auth.valid) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 403, origin, env);
      }

      const carts = await queryCollection(env, 'carts');
      return jsonResponse({ success: true, data: carts, count: carts.length }, 200, origin, env);
    }

    // GET /carts/:userId - Get a user's cart
    if (path.startsWith('/carts/') && method === 'GET') {
      const userId = path.split('/')[2];
      const cart = await getDocument(env, 'carts', userId);

      if (!cart) {
        return jsonResponse({ success: true, data: { items: [], total: 0 } }, 200, origin, env);
      }

      return jsonResponse({ success: true, data: cart }, 200, origin, env);
    }

    // ============================================
    // SAMPLE PACKS ROUTES
    // ============================================

    // GET /samplepacks - List all sample packs
    if (path === '/samplepacks' && method === 'GET') {
      const published = query.get('published');
      const options: any = {};

      if (published === 'true') {
        options.filters = [{ field: 'published', op: 'EQUAL', value: true }];
      }

      const packs = await queryCollection(env, 'samplePacks', options);
      return jsonResponse({ success: true, data: packs, count: packs.length }, 200, origin, env);
    }

    // GET /samplepacks/:id - Get a specific sample pack
    if (path.startsWith('/samplepacks/') && method === 'GET') {
      const id = path.split('/')[2];
      const pack = await getDocument(env, 'samplePacks', id);

      if (!pack) {
        return jsonResponse({ success: false, error: 'Sample pack not found' }, 404, origin, env);
      }

      return jsonResponse({ success: true, data: pack }, 200, origin, env);
    }

    // ============================================
    // GIFT CARDS ROUTES
    // ============================================

    // GET /giftcards - List all gift cards (admin only)
    if (path === '/giftcards' && method === 'GET') {
      const auth = verifyAdmin(request, env);
      if (!auth.valid) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 403, origin, env);
      }

      const cards = await queryCollection(env, 'giftCards');
      return jsonResponse({ success: true, data: cards, count: cards.length }, 200, origin, env);
    }

    // GET /giftcards/:code - Validate/lookup a gift card by code
    if (path.startsWith('/giftcards/') && method === 'GET') {
      const code = path.split('/')[2];

      // Query by code field
      const cards = await queryCollection(env, 'giftCards', {
        filters: [{ field: 'code', op: 'EQUAL', value: code }]
      });

      if (cards.length === 0) {
        return jsonResponse({ success: false, error: 'Gift card not found' }, 404, origin, env);
      }

      const card = cards[0];
      return jsonResponse({
        success: true,
        data: {
          code: card.code,
          balance: card.balance,
          originalAmount: card.originalAmount,
          status: card.status,
          isValid: card.status === 'active' && card.balance > 0
        }
      }, 200, origin, env);
    }

    // ============================================
    // MERCH ROUTES
    // ============================================

    // GET /merch - List all merch items
    if (path === '/merch' && method === 'GET') {
      const published = query.get('published');
      const options: any = {};

      if (published === 'true') {
        options.filters = [{ field: 'published', op: 'EQUAL', value: true }];
      }

      const merch = await queryCollection(env, 'merch', options);
      return jsonResponse({ success: true, data: merch, count: merch.length }, 200, origin, env);
    }

    // GET /merch/:id - Get a specific merch item
    if (path.startsWith('/merch/') && method === 'GET') {
      const id = path.split('/')[2];
      const item = await getDocument(env, 'merch', id);

      if (!item) {
        return jsonResponse({ success: false, error: 'Merch item not found' }, 404, origin, env);
      }

      return jsonResponse({ success: true, data: item }, 200, origin, env);
    }

    // ============================================
    // 404 NOT FOUND
    // ============================================
    return jsonResponse({
      success: false,
      error: 'Not found',
      message: `No route found for ${method} ${path}`
    }, 404, origin, env);

  } catch (error) {
    console.error('[worker] Error:', error);
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    }, 500, origin, env);
  }
}

// Scheduled task handler
async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  const trigger = event.cron;
  console.log(`[scheduled] Running cron: ${trigger}`);

  try {
    if (trigger === '0 */6 * * *') {
      // Every 6 hours: Cleanup old notifications
      console.log('[scheduled] Running notification cleanup...');
      // TODO: Implement notification cleanup
    }

    if (trigger === '0 9 * * *') {
      // Daily at 9am: Send pending request reminders
      console.log('[scheduled] Checking for stale pending requests...');
      // TODO: Implement stale request notifications
    }
  } catch (error) {
    console.error('[scheduled] Error:', error);
  }
}

// Export worker
export default {
  fetch: handleRequest,
  scheduled: handleScheduled
};
