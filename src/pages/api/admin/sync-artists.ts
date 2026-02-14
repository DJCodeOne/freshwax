// src/pages/api/admin/sync-artists.ts
// Syncs users with artist roles to the artists collection
import type { APIRoute } from 'astro';
import { getDocument, queryCollection, setDocument } from '../../../lib/firebase-rest';
import { getSaQuery } from '../../../lib/admin-query';
import { requireAdminAuth } from '../../../lib/admin';
import { parseJsonBody } from '../../../lib/api-utils';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env || {};
  const saQuery = getSaQuery(locals);

  try {
    const body = await parseJsonBody(request);

    // Check admin authentication
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    // Get users with limit to prevent runaway (admin operation)
    const users = await saQuery('users', {
      skipCache: true,
      limit: 500  // Max 500 users per sync to prevent runaway
    });
    console.log(`[sync-artists] Found ${users.length} users (limited to 500)`);

    // Get existing artists with limit
    const existingArtists = await saQuery('artists', {
      skipCache: true,
      limit: 500  // Max 500 artists to prevent runaway
    });
    const artistIds = new Set(existingArtists.map(a => a.id));
    console.log(`[sync-artists] Found ${existingArtists.length} existing artists (limited to 500)`);

    const synced: string[] = [];
    const errors: string[] = [];
    const usersWithArtistRole: string[] = [];

    for (const user of users) {
      const roles = user.roles || {};

      // Log users with artist role for debugging
      if (roles.artist || roles.merchSeller) {
        usersWithArtistRole.push(`${user.displayName || user.email || user.id} (artist: ${roles.artist}, merch: ${roles.merchSeller}, inArtists: ${artistIds.has(user.id)})`);
      }

      // Check if user has artist or merchSeller role but no artists entry
      if ((roles.artist || roles.merchSeller) && !artistIds.has(user.id)) {
        try {
          const pendingArtist = user.pendingRoles?.artist || {};
          const pendingMerch = user.pendingRoles?.merchSeller || {};

          await setDocument('artists', user.id, {
            id: user.id,
            userId: user.id,
            artistName: pendingArtist.artistName || user.displayName || user.name || 'Partner',
            name: user.fullName || user.name || user.displayName || '',
            displayName: pendingArtist.artistName || user.displayName || '',
            email: user.email || '',
            phone: user.phone || '',
            bio: pendingArtist.bio || '',
            links: pendingArtist.links || '',
            businessName: pendingMerch.businessName || '',
            isArtist: roles.artist || false,
            isDJ: roles.dj || roles.djEligible || false,
            isMerchSupplier: roles.merchSeller || false,
            approved: true,
            suspended: false,
            approvedAt: pendingArtist.approvedAt || pendingMerch.approvedAt || new Date().toISOString(),
            registeredAt: user.createdAt || new Date().toISOString(),
            createdAt: user.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });

          synced.push(`${user.displayName || user.email || user.id}`);
          console.log(`[sync-artists] Created artists/${user.id} for ${user.displayName || user.email}`);
        } catch (err) {
          const errorMsg = `Failed to sync ${user.id}: ${err}`;
          errors.push(errorMsg);
          console.error(`[sync-artists] ${errorMsg}`);
        }
      }
    }

    return new Response(JSON.stringify({
      success: true,
      synced,
      syncedCount: synced.length,
      errors,
      errorCount: errors.length,
      debug: {
        totalUsers: users.length,
        totalExistingArtists: existingArtists.length,
        usersWithArtistRole
      },
      message: synced.length > 0
        ? `Synced ${synced.length} artist(s) to artists collection`
        : 'All artists already synced'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[sync-artists] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to sync artists'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
