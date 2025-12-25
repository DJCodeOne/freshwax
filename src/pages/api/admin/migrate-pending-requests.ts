// src/pages/api/admin/migrate-pending-requests.ts
// Migrate existing pendingRoles from users collection to pendingRoleRequests collection
import type { APIRoute } from 'astro';
import { queryCollection, setDocument, getDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

// SECURITY: No fallback - ADMIN_KEY must be set in environment
const ADMIN_KEY = import.meta.env.ADMIN_KEY;
const ADMIN_UIDS = ['Y3TGc171cHSWTqZDRSniyu7Jxc33', '8WmxYeCp4PSym5iWHahgizokn5F2'];

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const { adminKey, adminUid } = body;

    // Verify admin access
    if (adminKey !== ADMIN_KEY && !ADMIN_UIDS.includes(adminUid)) {
      const adminDoc = adminUid ? await getDocument('admins', adminUid) : null;
      if (!adminDoc) {
        return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Query users collection - this may fail due to auth, so we'll use a different approach
    // Query the pendingRoleRequests to see what we already have
    const existingRequests = await queryCollection('pendingRoleRequests', { skipCache: true, limit: 200 });
    const existingIds = new Set(existingRequests.map(r => r.id));
    console.log(`[migrate] Found ${existingRequests.length} existing pendingRoleRequests`);

    // For now, accept a list of pending requests to migrate from the request body
    const { pendingUsers } = body;

    if (!pendingUsers || !Array.isArray(pendingUsers)) {
      return new Response(JSON.stringify({
        success: true,
        message: 'No pending users provided to migrate. Pass pendingUsers array in request body.',
        existingCount: existingRequests.length
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const migrated: string[] = [];
    const errors: string[] = [];

    for (const user of pendingUsers) {
      const { uid, displayName, email, pendingRoles } = user;

      if (!uid || !pendingRoles) continue;

      // Migrate artist request
      if (pendingRoles.artist?.status === 'pending') {
        const docId = `${uid}_artist`;
        if (!existingIds.has(docId)) {
          try {
            await setDocument('pendingRoleRequests', docId, {
              id: docId,
              uid: uid,
              userId: uid,
              roleType: 'artist',
              displayName: displayName || '',
              email: email || '',
              status: 'pending',
              requestedAt: pendingRoles.artist.requestedAt || new Date().toISOString(),
              artistName: pendingRoles.artist.artistName || '',
              bio: pendingRoles.artist.bio || '',
              links: pendingRoles.artist.links || ''
            });
            migrated.push(`${displayName || uid} (artist)`);
            console.log(`[migrate] Created pendingRoleRequests/${docId}`);
          } catch (e) {
            errors.push(`Failed to migrate ${uid} artist: ${e}`);
          }
        }
      }

      // Migrate merchSeller request
      if (pendingRoles.merchSeller?.status === 'pending') {
        const docId = `${uid}_merchSeller`;
        if (!existingIds.has(docId)) {
          try {
            await setDocument('pendingRoleRequests', docId, {
              id: docId,
              uid: uid,
              userId: uid,
              roleType: 'merchSeller',
              displayName: displayName || '',
              email: email || '',
              status: 'pending',
              requestedAt: pendingRoles.merchSeller.requestedAt || new Date().toISOString(),
              businessName: pendingRoles.merchSeller.businessName || '',
              description: pendingRoles.merchSeller.description || '',
              website: pendingRoles.merchSeller.website || ''
            });
            migrated.push(`${displayName || uid} (merchSeller)`);
            console.log(`[migrate] Created pendingRoleRequests/${docId}`);
          } catch (e) {
            errors.push(`Failed to migrate ${uid} merchSeller: ${e}`);
          }
        }
      }

      // Migrate djBypass request
      if (pendingRoles.djBypass?.status === 'pending') {
        const docId = `${uid}_djBypass`;
        if (!existingIds.has(docId)) {
          try {
            await setDocument('pendingRoleRequests', docId, {
              id: docId,
              uid: uid,
              userId: uid,
              roleType: 'djBypass',
              displayName: displayName || '',
              email: email || '',
              status: 'pending',
              requestedAt: pendingRoles.djBypass.requestedAt || new Date().toISOString(),
              reason: pendingRoles.djBypass.reason || ''
            });
            migrated.push(`${displayName || uid} (djBypass)`);
            console.log(`[migrate] Created pendingRoleRequests/${docId}`);
          } catch (e) {
            errors.push(`Failed to migrate ${uid} djBypass: ${e}`);
          }
        }
      }
    }

    return new Response(JSON.stringify({
      success: true,
      migrated,
      migratedCount: migrated.length,
      errors,
      errorCount: errors.length,
      message: migrated.length > 0
        ? `Migrated ${migrated.length} pending request(s)`
        : 'No new requests to migrate'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[migrate-pending-requests] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Migration failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
