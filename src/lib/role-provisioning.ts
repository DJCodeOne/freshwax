// src/lib/role-provisioning.ts
// Provision artist/vinylSeller collection entries when roles are approved or revoked

import { getDocument, updateDocument, setDocument } from './firebase-rest';
import { createLogger } from './api-utils';

const log = createLogger('role-provisioning');

/**
 * Create or update an artist/merchSeller record in the artists collection
 * when their role is approved.
 */
export async function provisionArtistRecord(
  uid: string,
  roleType: 'artist' | 'merchSeller',
  adminUid: string,
  userData: Record<string, unknown> | null
): Promise<void> {
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
      await updateDocument('artists', uid, {
        ...artistData,
        isArtist: roleType === 'artist' ? true : existingArtist.isArtist || false,
        isMerchSupplier: roleType === 'merchSeller' ? true : existingArtist.isMerchSupplier || false,
        createdAt: existingArtist.createdAt || new Date().toISOString()
      });
    } else {
      await setDocument('artists', uid, {
        ...artistData,
        registeredAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      });
    }
  } catch (artistError: unknown) {
    log.error(`[role-provisioning] Failed to create/update artists collection for ${uid}:`, artistError);
  }
}

/**
 * Create or update a vinylSeller record when their role is approved.
 */
export async function provisionVinylSellerRecord(
  uid: string,
  adminUid: string,
  userData: Record<string, unknown> | null
): Promise<void> {
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
    } else {
      await setDocument('vinylSellers', uid, {
        ...vinylSellerData,
        createdAt: new Date().toISOString()
      });
    }
  } catch (vinylError: unknown) {
    log.error(`[role-provisioning] Failed to create/update vinylSellers collection for ${uid}:`, vinylError);
  }
}

/**
 * Revoke an artist/merchSeller role in the artists collection.
 */
export async function revokeArtistRecord(
  uid: string,
  roleType: 'artist' | 'merchSeller',
  adminUid: string
): Promise<void> {
  try {
    const existingArtist = await getDocument('artists', uid);
    if (existingArtist) {
      const artistUpdate: Record<string, unknown> = {
        updatedAt: new Date().toISOString(),
        revokedAt: new Date().toISOString(),
        revokedBy: adminUid
      };
      if (roleType === 'artist') artistUpdate.isArtist = false;
      if (roleType === 'merchSeller') artistUpdate.isMerchSupplier = false;
      await updateDocument('artists', uid, artistUpdate);
    }
  } catch (e: unknown) {
    log.error(`[role-provisioning] Failed to update artists/${uid} during revoke:`, e);
  }
}

/**
 * Revoke a vinylSeller role in the vinylSellers collection.
 */
export async function revokeVinylSellerRecord(
  uid: string,
  adminUid: string
): Promise<void> {
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
    }
  } catch (e: unknown) {
    log.error(`[role-provisioning] Failed to update vinylSellers/${uid} during revoke:`, e);
  }
}
