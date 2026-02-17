import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, queryCollection, addDocument, setDocument, deleteDocument, verifyRequestUser } from '../../../lib/firebase-rest';
import { isAdmin, initAdminEnv } from '../../../lib/admin';
import { ApiErrors } from '../../../lib/api-utils';

const rolesManagePostSchema = z.object({
  action: z.enum(['requestRole', 'approveRole', 'denyRole', 'revokeRole']),
  uid: z.string().min(1),
  roleType: z.string().optional(),
  reason: z.string().optional(),
  artistName: z.string().optional(),
  bio: z.string().optional(),
  links: z.string().optional(),
  businessName: z.string().optional(),
  description: z.string().optional(),
  website: z.string().optional(),
  storeName: z.string().optional(),
  location: z.string().optional(),
  discogsUrl: z.string().optional(),
});

export const prerender = false;

export const GET: APIRoute = async ({ request, url, locals }) => {
  const env = locals.runtime.env;

  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });

  const action = url.searchParams.get('action');
  const uid = url.searchParams.get('uid');

  try {
    // Get user's roles — require auth and verify uid matches
    if (action === 'getUserRoles' && uid) {
      const { userId: verifiedUid, error: authError } = await verifyRequestUser(request);
      if (authError || !verifiedUid || verifiedUid !== uid) {
        return ApiErrors.unauthorized('Unauthorized');
      }

      const userData = await getDocument('users', uid);

      if (!userData) {
        return ApiErrors.notFound('User not found');
      }
      return new Response(JSON.stringify({
        success: true,
        roles: userData.roles || {},
        pendingRoles: userData.pendingRoles || {}
      }));
    }

    // Get pending requests (admin only)
    if (action === 'getPendingRequests') {
      const { userId: verifiedUid, error: authError } = await verifyRequestUser(request);
      if (authError || !verifiedUid || !(await isAdmin(verifiedUid))) {
        return ApiErrors.forbidden('Unauthorized');
      }

      // Query the pendingRoleRequests collection (publicly readable)
      const pendingRequests = await queryCollection('pendingRoleRequests', {
        skipCache: true,
        filters: [{ field: 'status', op: 'EQUAL', value: 'pending' }]
      });

      const requests = {
        artist: [] as any[],
        merchSeller: [] as any[],
        vinylSeller: [] as any[],
        djBypass: [] as any[]
      };

      pendingRequests.forEach((req: any) => {
        const roleType = req.roleType;
        if (roleType === 'artist') {
          requests.artist.push(req);
        } else if (roleType === 'merchSeller') {
          requests.merchSeller.push(req);
        } else if (roleType === 'vinylSeller') {
          requests.vinylSeller.push(req);
        } else if (roleType === 'djBypass') {
          requests.djBypass.push(req);
        }
      });

      return new Response(JSON.stringify({
        success: true,
        requests,
        totalPending: pendingRequests.length
      }));
    }

    return ApiErrors.badRequest('Invalid action');

  } catch (error: unknown) {
    console.error('Roles API GET error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;

  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });

  try {
    // SECURITY: Verify Firebase token for all POST actions
    const { userId: verifiedUid, error: authError } = await verifyRequestUser(request);
    if (authError || !verifiedUid) {
      return ApiErrors.unauthorized('Authentication required');
    }

    const body = await request.json();

    const parsed = rolesManagePostSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { action, uid, roleType, reason, artistName, bio, links, businessName, description, website, storeName, location, discogsUrl } = parsed.data;

    // Request a role (user action)
    if (action === 'requestRole') {
      if (!roleType) {
        return ApiErrors.badRequest('Missing roleType');
      }

      // SECURITY: Verify the requesting user matches the uid
      if (verifiedUid !== uid) {
        return ApiErrors.forbidden('Cannot request roles for another user');
      }

      const validRoles = ['artist', 'merchSeller', 'vinylSeller', 'djBypass'];
      if (!validRoles.includes(roleType)) {
        return ApiErrors.badRequest('Invalid role type');
      }

      const userData = await getDocument('users', uid);

      if (!userData) {
        return ApiErrors.notFound('User not found');
      }
      
      // Check if already has role
      if (userData?.roles?.[roleType === 'djBypass' ? 'djEligible' : roleType]) {
        return ApiErrors.badRequest('Already has this role');
      }

      // Check if already pending
      if (userData?.pendingRoles?.[roleType]?.status === 'pending') {
        return ApiErrors.badRequest('Request already pending');
      }

      // Build request data based on role type
      const requestData: any = {
        requestedAt: new Date().toISOString(),
        status: 'pending'
      };

      if (roleType === 'artist') {
        requestData.artistName = artistName || '';
        requestData.bio = bio || '';
        requestData.links = links || '';
      } else if (roleType === 'merchSeller') {
        requestData.businessName = businessName || '';
        requestData.description = description || '';
        requestData.website = website || '';
      } else if (roleType === 'vinylSeller') {
        requestData.storeName = storeName || '';
        requestData.description = description || '';
        requestData.location = location || '';
        requestData.discogsUrl = discogsUrl || '';
      } else if (roleType === 'djBypass') {
        requestData.reason = reason || '';
      }

      // Update users collection (for client-side Firebase SDK access)
      await updateDocument('users', uid, {
        [`pendingRoles.${roleType}`]: requestData,
        updatedAt: new Date()
      });

      // Also write to pendingRoleRequests collection (for REST API access)
      // Document ID format: {uid}_{roleType}
      const pendingRequestDoc = {
        id: `${uid}_${roleType}`,
        uid: uid,
        userId: uid,
        roleType: roleType,
        displayName: userData.displayName || userData.name || '',
        email: userData.email || '',
        ...requestData
      };

      await setDocument('pendingRoleRequests', `${uid}_${roleType}`, pendingRequestDoc);
      // Created pendingRoleRequests entry

      return new Response(JSON.stringify({
        success: true,
        message: 'Request submitted'
      }));
    }

    // Approve role (admin action)
    if (action === 'approveRole') {
      if (!(await isAdmin(verifiedUid))) {
        return ApiErrors.forbidden('Unauthorized');
      }
      const adminUid = verifiedUid;

      if (!uid || !roleType) {
        return ApiErrors.badRequest('Missing uid or roleType');
      }

      const roleKey = roleType === 'djBypass' ? 'djEligible' : roleType;

      // Get user data first for artist record
      const userData = await getDocument('users', uid);

      await updateDocument('users', uid, {
        [`roles.${roleKey}`]: true,
        [`pendingRoles.${roleType}.status`]: 'approved',
        [`pendingRoles.${roleType}.approvedAt`]: new Date(),
        [`pendingRoles.${roleType}.approvedBy`]: adminUid,
        updatedAt: new Date()
      });

      // Also update customers collection - create if doesn't exist
      try {
        const existingCustomer = await getDocument('users', uid);
        const customerData = {
          [`roles.${roleKey}`]: true,
          isArtist: roleType === 'artist' ? true : (existingCustomer?.isArtist || false),
          isMerchSupplier: roleType === 'merchSeller' ? true : (existingCustomer?.isMerchSupplier || false),
          isVinylSeller: roleType === 'vinylSeller' ? true : (existingCustomer?.isVinylSeller || false),
          approved: true,
          updatedAt: new Date().toISOString()
        };

        if (existingCustomer) {
          await updateDocument('users', uid, customerData);
        } else {
          // Create customers doc if it doesn't exist
          await setDocument('users', uid, {
            uid: uid,
            email: userData?.email || '',
            displayName: userData?.displayName || '',
            createdAt: new Date().toISOString(),
            ...customerData
          });
          // Created customers entry during approval
        }
      } catch (e) {
        console.error(`[roles/manage] Failed to update customers/${uid}:`, e);
      }

      // Delete from pendingRoleRequests collection
      try {
        await deleteDocument('pendingRoleRequests', `${uid}_${roleType}`);
        // Deleted pendingRoleRequests entry
      } catch (e) {
        // May not exist if created before this system
        // pendingRoleRequests not found (may be legacy)
      }

      // For artist or merchSeller roles, create/update artists collection entry
      if (roleType === 'artist' || roleType === 'merchSeller') {
        try {
          const pendingData = userData?.pendingRoles?.[roleType] || {};
          const existingArtist = await getDocument('artists', uid);

          const artistData = {
            id: uid,
            userId: uid,
            artistName: pendingData.artistName || userData?.displayName || userData?.name || 'Partner',
            name: userData?.fullName || userData?.name || userData?.displayName || '',
            displayName: pendingData.artistName || userData?.displayName || '',
            email: userData?.email || '',
            phone: userData?.phone || '',
            bio: pendingData.bio || '',
            links: pendingData.links || '',
            businessName: pendingData.businessName || '',
            isArtist: roleType === 'artist',
            isDJ: false,
            isMerchSupplier: roleType === 'merchSeller',
            approved: true,
            suspended: false,
            approvedAt: new Date().toISOString(),
            approvedBy: adminUid,
            updatedAt: new Date().toISOString()
          };

          if (existingArtist) {
            // Update existing artist record - merge with existing data
            await updateDocument('artists', uid, {
              ...artistData,
              isArtist: roleType === 'artist' ? true : existingArtist.isArtist || false,
              isMerchSupplier: roleType === 'merchSeller' ? true : existingArtist.isMerchSupplier || false,
              createdAt: existingArtist.createdAt || new Date().toISOString()
            });
            // Updated artists entry
          } else {
            // Create new artist record
            await setDocument('artists', uid, {
              ...artistData,
              registeredAt: new Date().toISOString(),
              createdAt: new Date().toISOString()
            });
            // Created artists entry
          }
        } catch (artistError) {
          console.error(`[roles/manage] Failed to create/update artists collection for ${uid}:`, artistError);
          // Don't fail the whole approval - user role is still granted
        }
      }

      // For vinylSeller role, create vinylSellers collection entry
      if (roleType === 'vinylSeller') {
        try {
          const pendingData = userData?.pendingRoles?.vinylSeller || {};
          const existingVinylSeller = await getDocument('vinylSellers', uid);

          const vinylSellerData = {
            id: uid,
            userId: uid,
            storeName: pendingData.storeName || userData?.displayName || 'Vinyl Store',
            description: pendingData.description || '',
            location: pendingData.location || '',
            discogsUrl: pendingData.discogsUrl || '',
            email: userData?.email || '',
            displayName: userData?.displayName || '',
            approved: true,
            suspended: false,
            totalSales: 0,
            activeListings: 0,
            ratings: {
              average: 0,
              count: 0,
              breakdown: {
                communication: 0,
                accuracy: 0,
                shipping: 0
              }
            },
            approvedAt: new Date().toISOString(),
            approvedBy: adminUid,
            updatedAt: new Date().toISOString()
          };

          if (existingVinylSeller) {
            await updateDocument('vinylSellers', uid, {
              ...vinylSellerData,
              createdAt: existingVinylSeller.createdAt || new Date().toISOString()
            });
            // Updated vinylSellers entry
          } else {
            await setDocument('vinylSellers', uid, {
              ...vinylSellerData,
              createdAt: new Date().toISOString()
            });
            // Created vinylSellers entry
          }
        } catch (vinylError) {
          console.error(`[roles/manage] Failed to create/update vinylSellers collection for ${uid}:`, vinylError);
        }
      }

      // Create notification for user
      const roleDisplayName = roleType === 'djBypass' ? 'DJ Bypass' :
                              roleType === 'merchSeller' ? 'Merch Seller' :
                              roleType === 'vinylSeller' ? 'Vinyl Seller' : 'Artist';
      await addDocument('notifications', {
        userId: uid,
        type: 'role_approved',
        title: `${roleDisplayName} Request Approved`,
        message: `Your ${roleDisplayName} request has been approved!`,
        read: false,
        createdAt: new Date()
      });

      return new Response(JSON.stringify({
        success: true,
        message: 'Role approved'
      }));
    }

    // Deny role (admin action)
    if (action === 'denyRole') {
      if (!(await isAdmin(verifiedUid))) {
        return ApiErrors.forbidden('Unauthorized');
      }
      const adminUid = verifiedUid;

      if (!uid || !roleType) {
        return ApiErrors.badRequest('Missing uid or roleType');
      }

      await updateDocument('users', uid, {
        [`pendingRoles.${roleType}.status`]: 'denied',
        [`pendingRoles.${roleType}.deniedAt`]: new Date(),
        [`pendingRoles.${roleType}.deniedBy`]: adminUid,
        [`pendingRoles.${roleType}.denialReason`]: reason || '',
        updatedAt: new Date()
      });

      // Delete from pendingRoleRequests collection
      try {
        await deleteDocument('pendingRoleRequests', `${uid}_${roleType}`);
        // Deleted pendingRoleRequests entry (denied)
      } catch (e) {
        // May not exist if created before this system
      }

      // Create notification for user
      const denyRoleDisplayName = roleType === 'djBypass' ? 'DJ Bypass' :
                                   roleType === 'merchSeller' ? 'Merch Seller' :
                                   roleType === 'vinylSeller' ? 'Vinyl Seller' : 'Artist';
      await addDocument('notifications', {
        userId: uid,
        type: 'role_denied',
        title: `${denyRoleDisplayName} Request Denied`,
        message: reason ? `Your request was denied: ${reason}` : 'Your request was denied.',
        read: false,
        createdAt: new Date()
      });

      return new Response(JSON.stringify({
        success: true,
        message: 'Role denied'
      }));
    }

    // Revoke role (admin action)
    if (action === 'revokeRole') {
      if (!(await isAdmin(verifiedUid))) {
        return ApiErrors.forbidden('Unauthorized');
      }
      const adminUid = verifiedUid;

      if (!uid || !roleType) {
        return ApiErrors.badRequest('Missing uid or roleType');
      }

      const roleKey = roleType === 'djBypass' ? 'djEligible' : roleType;

      // Update users collection
      await updateDocument('users', uid, {
        [`roles.${roleKey}`]: false,
        updatedAt: new Date()
      });

      // Also update customers collection
      try {
        const existingCustomer = await getDocument('users', uid);
        if (existingCustomer) {
          const customerUpdate: any = {
            [`roles.${roleKey}`]: false,
            updatedAt: new Date().toISOString()
          };
          if (roleType === 'artist') customerUpdate.isArtist = false;
          if (roleType === 'merchSeller') customerUpdate.isMerchSupplier = false;
          if (roleType === 'vinylSeller') customerUpdate.isVinylSeller = false;
          await updateDocument('users', uid, customerUpdate);
        }
      } catch (e) {
        console.error(`[roles/manage] Failed to update customers/${uid} during revoke:`, e);
      }

      // Update artists collection if revoking artist/merch role
      if (roleType === 'artist' || roleType === 'merchSeller') {
        try {
          const existingArtist = await getDocument('artists', uid);
          if (existingArtist) {
            const artistUpdate: any = {
              updatedAt: new Date().toISOString(),
              revokedAt: new Date().toISOString(),
              revokedBy: adminUid
            };
            if (roleType === 'artist') artistUpdate.isArtist = false;
            if (roleType === 'merchSeller') artistUpdate.isMerchSupplier = false;
            await updateDocument('artists', uid, artistUpdate);
            // Revoked role from artists
          }
        } catch (e) {
          console.error(`[roles/manage] Failed to update artists/${uid} during revoke:`, e);
        }
      }

      // Update vinylSellers collection if revoking vinyl seller role
      if (roleType === 'vinylSeller') {
        try {
          const existingVinylSeller = await getDocument('vinylSellers', uid);
          if (existingVinylSeller) {
            await updateDocument('vinylSellers', uid, {
              approved: false,
              suspended: true,
              updatedAt: new Date().toISOString(),
              revokedAt: new Date().toISOString(),
              revokedBy: adminUid
            });
            // Revoked vinylSeller role
          }
        } catch (e) {
          console.error(`[roles/manage] Failed to update vinylSellers/${uid} during revoke:`, e);
        }
      }

      return new Response(JSON.stringify({
        success: true,
        message: 'Role revoked'
      }));
    }

    return ApiErrors.badRequest('Invalid action');

  } catch (error: unknown) {
    console.error('Roles API POST error:', error instanceof Error ? error.message : String(error));
    return ApiErrors.serverError('Internal error');
  }
};
