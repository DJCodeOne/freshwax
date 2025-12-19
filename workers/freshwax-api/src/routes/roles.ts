// Role Management Routes - Handles role requests, approvals, and denials
import type { Env, User, Artist, PendingRoleRequest } from '../types';
import {
  getDocument,
  setDocument,
  updateDocument,
  deleteDocument,
  queryCollection,
  addDocument,
  batchWrite
} from '../services/firebase';
import {
  sendEmail,
  artistApprovalEmail,
  merchSellerApprovalEmail,
  djBypassApprovalEmail,
  roleDenialEmail,
  newRequestNotificationEmail
} from '../services/email';

// Admin UIDs for authorization
const ADMIN_UIDS = ['Y3TGc171cHSWTqZDRSniyu7Jxc33', '8WmxYeCp4PSym5iWHahgizokn5F2'];

// Check if user is admin
async function isAdmin(env: Env, uid: string): Promise<boolean> {
  if (ADMIN_UIDS.includes(uid)) return true;
  const adminDoc = await getDocument(env, 'admins', uid);
  return !!adminDoc;
}

// ============================================
// GET PENDING REQUESTS
// ============================================
export async function getPendingRequests(env: Env, adminUid: string) {
  // Verify admin
  if (!await isAdmin(env, adminUid)) {
    return { success: false, error: 'Unauthorized', status: 403 };
  }

  // Query all users with pending roles
  const users = await queryCollection(env, 'users');

  const requests = {
    artist: [] as any[],
    merchSeller: [] as any[],
    djBypass: [] as any[]
  };

  for (const user of users) {
    const pending = user.pendingRoles || {};

    if (pending.artist?.status === 'pending') {
      requests.artist.push({
        uid: user.id,
        userId: user.id,
        displayName: user.displayName || '',
        email: user.email || '',
        ...pending.artist
      });
    }
    if (pending.merchSeller?.status === 'pending') {
      requests.merchSeller.push({
        uid: user.id,
        userId: user.id,
        displayName: user.displayName || '',
        email: user.email || '',
        ...pending.merchSeller
      });
    }
    if (pending.djBypass?.status === 'pending') {
      requests.djBypass.push({
        uid: user.id,
        userId: user.id,
        displayName: user.displayName || '',
        email: user.email || '',
        ...pending.djBypass
      });
    }
  }

  return {
    success: true,
    requests,
    totalPending: requests.artist.length + requests.merchSeller.length + requests.djBypass.length
  };
}

// ============================================
// REQUEST A ROLE
// ============================================
export async function requestRole(
  env: Env,
  uid: string,
  roleType: 'artist' | 'merchSeller' | 'djBypass',
  data: {
    artistName?: string;
    bio?: string;
    links?: string;
    businessName?: string;
    description?: string;
    website?: string;
    reason?: string;
  }
) {
  // Get user document
  const user = await getDocument(env, 'users', uid);
  if (!user) {
    return { success: false, error: 'User not found', status: 404 };
  }

  // Check if already has role
  const roleKey = roleType === 'djBypass' ? 'djEligible' : roleType;
  if (user.roles?.[roleKey]) {
    return { success: false, error: 'Already has this role', status: 400 };
  }

  // Check if already pending
  if (user.pendingRoles?.[roleType]?.status === 'pending') {
    return { success: false, error: 'Request already pending', status: 400 };
  }

  // Build request data
  const requestData: PendingRoleRequest = {
    status: 'pending',
    requestedAt: new Date().toISOString()
  };

  if (roleType === 'artist') {
    requestData.artistName = data.artistName || '';
    requestData.bio = data.bio || '';
    requestData.links = data.links || '';
  } else if (roleType === 'merchSeller') {
    requestData.businessName = data.businessName || '';
    requestData.description = data.description || '';
    requestData.website = data.website || '';
  } else if (roleType === 'djBypass') {
    requestData.reason = data.reason || '';
  }

  // Update user document
  await updateDocument(env, 'users', uid, {
    [`pendingRoles.${roleType}`]: requestData,
    updatedAt: new Date().toISOString()
  });

  // Send notification to admin
  const details: Record<string, string> = {};
  if (roleType === 'artist') {
    details['Artist Name'] = data.artistName || 'Not provided';
    details['Bio'] = data.bio || 'Not provided';
    details['Links'] = data.links || 'Not provided';
  } else if (roleType === 'merchSeller') {
    details['Business Name'] = data.businessName || 'Not provided';
    details['Description'] = data.description || 'Not provided';
    details['Website'] = data.website || 'Not provided';
  } else {
    details['Reason'] = data.reason || 'Not provided';
  }

  const notifEmail = newRequestNotificationEmail(
    roleType === 'artist' ? 'Artist' : roleType === 'merchSeller' ? 'Merch Seller' : 'DJ Bypass',
    user.displayName || 'Unknown',
    user.email || '',
    details
  );
  await sendEmail(env, notifEmail);

  return { success: true, message: 'Request submitted' };
}

// ============================================
// APPROVE A ROLE
// ============================================
export async function approveRole(
  env: Env,
  adminUid: string,
  uid: string,
  roleType: 'artist' | 'merchSeller' | 'djBypass'
) {
  // Verify admin
  if (!await isAdmin(env, adminUid)) {
    return { success: false, error: 'Unauthorized', status: 403 };
  }

  // Get user document
  const user = await getDocument(env, 'users', uid);
  if (!user) {
    return { success: false, error: 'User not found', status: 404 };
  }

  const pendingData = user.pendingRoles?.[roleType] || {};
  const roleKey = roleType === 'djBypass' ? 'djEligible' : roleType;

  // Update user document
  await updateDocument(env, 'users', uid, {
    [`roles.${roleKey}`]: true,
    [`pendingRoles.${roleType}.status`]: 'approved',
    [`pendingRoles.${roleType}.approvedAt`]: new Date().toISOString(),
    [`pendingRoles.${roleType}.approvedBy`]: adminUid,
    updatedAt: new Date().toISOString()
  });

  // Update or create customers document
  const existingCustomer = await getDocument(env, 'customers', uid);
  const customerData: Record<string, any> = {
    [`roles.${roleKey}`]: true,
    isArtist: roleType === 'artist' ? true : (existingCustomer?.isArtist || false),
    isMerchSupplier: roleType === 'merchSeller' ? true : (existingCustomer?.isMerchSupplier || false),
    approved: true,
    updatedAt: new Date().toISOString()
  };

  if (existingCustomer) {
    await updateDocument(env, 'customers', uid, customerData);
  } else {
    await setDocument(env, 'customers', uid, {
      uid: uid,
      email: user.email || '',
      displayName: user.displayName || '',
      createdAt: new Date().toISOString(),
      ...customerData
    });
  }

  // For artist/merchSeller, create/update artists collection
  if (roleType === 'artist' || roleType === 'merchSeller') {
    const existingArtist = await getDocument(env, 'artists', uid);

    const artistData: Partial<Artist> = {
      id: uid,
      userId: uid,
      artistName: pendingData.artistName || user.displayName || 'Partner',
      name: user.fullName || user.name || user.displayName || '',
      displayName: pendingData.artistName || user.displayName || '',
      email: user.email || '',
      phone: user.phone || '',
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
      await updateDocument(env, 'artists', uid, {
        ...artistData,
        isArtist: roleType === 'artist' ? true : existingArtist.isArtist || false,
        isMerchSupplier: roleType === 'merchSeller' ? true : existingArtist.isMerchSupplier || false,
        createdAt: existingArtist.createdAt
      });
    } else {
      await setDocument(env, 'artists', uid, {
        ...artistData,
        registeredAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      });
    }
  }

  // Create notification
  await addDocument(env, 'notifications', {
    userId: uid,
    type: 'role_approved',
    title: `${roleType === 'djBypass' ? 'DJ Bypass' : roleType === 'merchSeller' ? 'Merch Seller' : 'Artist'} Request Approved`,
    message: `Your ${roleType === 'djBypass' ? 'DJ bypass' : roleType} request has been approved!`,
    read: false,
    createdAt: new Date().toISOString()
  });

  // Send approval email
  let emailTemplate;
  if (roleType === 'artist') {
    emailTemplate = artistApprovalEmail(pendingData.artistName || 'Artist', user.displayName || '');
  } else if (roleType === 'merchSeller') {
    emailTemplate = merchSellerApprovalEmail(pendingData.businessName || 'Business', user.displayName || '');
  } else {
    emailTemplate = djBypassApprovalEmail(user.displayName || '');
  }
  emailTemplate.to = user.email || '';
  await sendEmail(env, emailTemplate);

  console.log(`[roles] Approved ${roleType} for ${uid} (${user.displayName})`);

  return { success: true, message: 'Role approved' };
}

// ============================================
// DENY A ROLE
// ============================================
export async function denyRole(
  env: Env,
  adminUid: string,
  uid: string,
  roleType: 'artist' | 'merchSeller' | 'djBypass',
  reason?: string
) {
  // Verify admin
  if (!await isAdmin(env, adminUid)) {
    return { success: false, error: 'Unauthorized', status: 403 };
  }

  // Get user document
  const user = await getDocument(env, 'users', uid);
  if (!user) {
    return { success: false, error: 'User not found', status: 404 };
  }

  // Update user document
  await updateDocument(env, 'users', uid, {
    [`pendingRoles.${roleType}.status`]: 'denied',
    [`pendingRoles.${roleType}.deniedAt`]: new Date().toISOString(),
    [`pendingRoles.${roleType}.deniedBy`]: adminUid,
    [`pendingRoles.${roleType}.denialReason`]: reason || '',
    updatedAt: new Date().toISOString()
  });

  // Create notification
  await addDocument(env, 'notifications', {
    userId: uid,
    type: 'role_denied',
    title: `${roleType === 'djBypass' ? 'DJ Bypass' : roleType === 'merchSeller' ? 'Merch Seller' : 'Artist'} Request Denied`,
    message: reason ? `Your request was denied: ${reason}` : 'Your request was denied.',
    read: false,
    createdAt: new Date().toISOString()
  });

  // Send denial email
  const emailTemplate = roleDenialEmail(user.displayName || '', roleType, reason);
  emailTemplate.to = user.email || '';
  await sendEmail(env, emailTemplate);

  console.log(`[roles] Denied ${roleType} for ${uid} (${user.displayName})`);

  return { success: true, message: 'Role denied' };
}

// ============================================
// REVOKE A ROLE
// ============================================
export async function revokeRole(
  env: Env,
  adminUid: string,
  uid: string,
  roleType: 'artist' | 'merchSeller' | 'djBypass'
) {
  // Verify admin
  if (!await isAdmin(env, adminUid)) {
    return { success: false, error: 'Unauthorized', status: 403 };
  }

  const roleKey = roleType === 'djBypass' ? 'djEligible' : roleType;

  // Update user document
  await updateDocument(env, 'users', uid, {
    [`roles.${roleKey}`]: false,
    updatedAt: new Date().toISOString()
  });

  // Update artists collection if applicable
  if (roleType === 'artist' || roleType === 'merchSeller') {
    const existingArtist = await getDocument(env, 'artists', uid);
    if (existingArtist) {
      await updateDocument(env, 'artists', uid, {
        [roleType === 'artist' ? 'isArtist' : 'isMerchSupplier']: false,
        suspended: true,
        updatedAt: new Date().toISOString()
      });
    }
  }

  console.log(`[roles] Revoked ${roleType} for ${uid}`);

  return { success: true, message: 'Role revoked' };
}

// ============================================
// GET USER ROLES
// ============================================
export async function getUserRoles(env: Env, uid: string) {
  const user = await getDocument(env, 'users', uid);

  if (!user) {
    return { success: false, error: 'User not found', status: 404 };
  }

  return {
    success: true,
    roles: user.roles || {},
    pendingRoles: user.pendingRoles || {}
  };
}
