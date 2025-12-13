import type { APIRoute } from 'astro';
import { getDocument, updateDocument, queryCollection, addDocument } from '../../../lib/firebase-rest';
const ADMIN_UID = 'Y3TGc171cHSWTqZDRSniyu7Jxc33';

// Helper to check if user is admin
async function isAdmin(uid: string): Promise<boolean> {
  if (uid === ADMIN_UID) return true;
  const adminDoc = await getDocument('admins', uid);
  return !!adminDoc;
}

export const GET: APIRoute = async ({ request, url }) => {
  const action = url.searchParams.get('action');
  const uid = url.searchParams.get('uid');

  try {
    // Get user's roles
    if (action === 'getUserRoles' && uid) {
      const userData = await getDocument('users', uid);

      if (!userData) {
        return new Response(JSON.stringify({
          success: false,
          error: 'User not found'
        }), { status: 404 });
      }
      return new Response(JSON.stringify({
        success: true,
        roles: userData.roles || {},
        pendingRoles: userData.pendingRoles || {}
      }));
    }

    // Get pending requests (admin only)
    if (action === 'getPendingRequests') {
      const authHeader = request.headers.get('Authorization');
      const adminUid = authHeader?.replace('Bearer ', '');
      
      if (!adminUid || !(await isAdmin(adminUid))) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Unauthorized' 
        }), { status: 403 });
      }

      const users = await queryCollection('users', {});
      const requests = {
        artist: [] as any[],
        merchSeller: [] as any[],
        djBypass: [] as any[]
      };

      users.forEach(user => {
        const pending = user.pendingRoles || {};

        if (pending.artist?.status === 'pending') {
          requests.artist.push({ ...user, request: pending.artist });
        }
        if (pending.merchSeller?.status === 'pending') {
          requests.merchSeller.push({ ...user, request: pending.merchSeller });
        }
        if (pending.djBypass?.status === 'pending') {
          requests.djBypass.push({ ...user, request: pending.djBypass });
        }
      });

      return new Response(JSON.stringify({
        success: true,
        requests
      }));
    }

    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Invalid action' 
    }), { status: 400 });

  } catch (error: any) {
    console.error('Roles API GET error:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error.message 
    }), { status: 500 });
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { action, uid, roleType, reason, adminUid, artistName, bio, links, businessName, description, website } = body;

    // Request a role (user action)
    if (action === 'requestRole') {
      if (!uid || !roleType) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Missing uid or roleType' 
        }), { status: 400 });
      }

      const validRoles = ['artist', 'merchSeller', 'djBypass'];
      if (!validRoles.includes(roleType)) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid role type'
        }), { status: 400 });
      }

      const userData = await getDocument('users', uid);

      if (!userData) {
        return new Response(JSON.stringify({
          success: false,
          error: 'User not found'
        }), { status: 404 });
      }
      
      // Check if already has role
      if (userData?.roles?.[roleType === 'djBypass' ? 'djEligible' : roleType]) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Already has this role' 
        }), { status: 400 });
      }

      // Check if already pending
      if (userData?.pendingRoles?.[roleType]?.status === 'pending') {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Request already pending' 
        }), { status: 400 });
      }

      // Build request data based on role type
      const requestData: any = {
        requestedAt: FieldValue.serverTimestamp(),
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
      } else if (roleType === 'djBypass') {
        requestData.reason = reason || '';
      }

      await updateDocument('users', uid, {
        [`pendingRoles.${roleType}`]: requestData,
        updatedAt: new Date()
      });

      return new Response(JSON.stringify({
        success: true,
        message: 'Request submitted'
      }));
    }

    // Approve role (admin action)
    if (action === 'approveRole') {
      if (!adminUid || !(await isAdmin(adminUid))) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Unauthorized' 
        }), { status: 403 });
      }

      if (!uid || !roleType) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Missing uid or roleType' 
        }), { status: 400 });
      }

      const roleKey = roleType === 'djBypass' ? 'djEligible' : roleType;

      await updateDocument('users', uid, {
        [`roles.${roleKey}`]: true,
        [`pendingRoles.${roleType}.status`]: 'approved',
        [`pendingRoles.${roleType}.approvedAt`]: new Date(),
        [`pendingRoles.${roleType}.approvedBy`]: adminUid,
        updatedAt: new Date()
      });

      // Create notification for user
      await addDocument('notifications', {
        userId: uid,
        type: 'role_approved',
        title: `${roleType === 'djBypass' ? 'DJ Bypass' : roleType === 'merchSeller' ? 'Merch Seller' : 'Artist'} Request Approved`,
        message: `Your ${roleType === 'djBypass' ? 'DJ bypass' : roleType} request has been approved!`,
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
      if (!adminUid || !(await isAdmin(adminUid))) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Unauthorized' 
        }), { status: 403 });
      }

      if (!uid || !roleType) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Missing uid or roleType' 
        }), { status: 400 });
      }

      await updateDocument('users', uid, {
        [`pendingRoles.${roleType}.status`]: 'denied',
        [`pendingRoles.${roleType}.deniedAt`]: new Date(),
        [`pendingRoles.${roleType}.deniedBy`]: adminUid,
        [`pendingRoles.${roleType}.denialReason`]: reason || '',
        updatedAt: new Date()
      });

      // Create notification for user
      await addDocument('notifications', {
        userId: uid,
        type: 'role_denied',
        title: `${roleType === 'djBypass' ? 'DJ Bypass' : roleType === 'merchSeller' ? 'Merch Seller' : 'Artist'} Request Denied`,
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
      if (!adminUid || !(await isAdmin(adminUid))) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Unauthorized' 
        }), { status: 403 });
      }

      if (!uid || !roleType) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Missing uid or roleType' 
        }), { status: 400 });
      }

      const roleKey = roleType === 'djBypass' ? 'djEligible' : roleType;

      await updateDocument('users', uid, {
        [`roles.${roleKey}`]: false,
        updatedAt: new Date()
      });

      return new Response(JSON.stringify({
        success: true,
        message: 'Role revoked'
      }));
    }

    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Invalid action' 
    }), { status: 400 });

  } catch (error: any) {
    console.error('Roles API POST error:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error.message 
    }), { status: 500 });
  }
};
