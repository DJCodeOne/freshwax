import type { APIRoute } from 'astro';
import { getDocument, updateDocument, queryCollection, initFirebaseEnv } from '../../../../lib/firebase-rest';
import { requireAdminAuth, initAdminEnv } from '../../../../lib/admin';

export const prerender = false;

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

export const GET: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  const env = locals?.runtime?.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });

  // Verify admin authentication for GET as well (sensitive seller data)
  const authError = requireAdminAuth(request, locals);
  if (authError) return authError;

  const url = new URL(request.url);
  const sellerId = url.searchParams.get('id');

  if (!sellerId) {
    return new Response(JSON.stringify({ success: false, error: 'Seller ID required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // First try vinylSellers collection (legacy)
    let seller = await getDocument('vinylSellers', sellerId);
    let source = 'vinylSellers';

    // If not found, try users collection (new system)
    if (!seller) {
      const user = await getDocument('users', sellerId);
      if (user && user.roles?.vinylSeller === true) {
        seller = {
          id: user.id,
          storeName: user.partnerInfo?.storeName || user.partnerInfo?.displayName || user.displayName || 'Unnamed Store',
          email: user.email,
          location: user.partnerInfo?.location || user.address?.city || '',
          approved: user.approved === true || user.partnerInfo?.approved === true ||
                    user.pendingRoles?.vinylSeller?.status === 'approved',
          suspended: user.suspended === true || user.disabled === true,
          discogsUrl: user.partnerInfo?.discogsUrl || '',
          description: user.partnerInfo?.description || '',
          createdAt: user.createdAt,
          userId: user.id
        };
        source = 'users';
      }
    }

    if (!seller) {
      return new Response(JSON.stringify({ success: false, error: 'Seller not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ success: true, seller, source }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('[API vinyl/seller] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Failed to fetch seller' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  const env = locals?.runtime?.env;
  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });

  try {
    const body = await request.json();

    // Verify admin authentication
    const authError = requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const { action, sellerId, source } = body;

    if (!sellerId) {
      return new Response(JSON.stringify({ success: false, error: 'Seller ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Determine collection - check if seller exists in vinylSellers or users
    let seller = await getDocument('vinylSellers', sellerId);
    let collection = 'vinylSellers';

    if (!seller) {
      const user = await getDocument('users', sellerId);
      if (user && user.roles?.vinylSeller === true) {
        seller = user;
        collection = 'users';
      }
    }

    if (!seller) {
      return new Response(JSON.stringify({ success: false, error: 'Seller not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    switch (action) {
      case 'update': {
        const { storeName, description, location, discogsUrl, approved, suspended } = body;

        if (collection === 'users') {
          // Update user document
          const updateData: any = {
            updatedAt: new Date().toISOString(),
            'partnerInfo.storeName': storeName,
            'partnerInfo.description': description,
            'partnerInfo.location': location,
            'partnerInfo.discogsUrl': discogsUrl
          };
          if (approved !== undefined) updateData.approved = approved;
          if (suspended !== undefined) updateData.suspended = suspended;
          if (approved !== undefined || suspended !== undefined) {
            updateData['roles.vinylSeller'] = approved && !suspended;
          }

          await updateDocument('users', sellerId, updateData);
        } else {
          // Update vinylSellers document (legacy)
          const updateData: any = {
            updatedAt: new Date().toISOString()
          };

          if (storeName !== undefined) updateData.storeName = storeName;
          if (description !== undefined) updateData.description = description;
          if (location !== undefined) updateData.location = location;
          if (discogsUrl !== undefined) updateData.discogsUrl = discogsUrl;
          if (approved !== undefined) updateData.approved = approved;
          if (suspended !== undefined) updateData.suspended = suspended;

          await updateDocument('vinylSellers', sellerId, updateData);

          // Also update the user's roles if approval status changed
          if (approved !== undefined || suspended !== undefined) {
            try {
              const userId = seller.userId || sellerId;
              await updateDocument('users', userId, {
                'roles.vinylSeller': approved && !suspended,
                updatedAt: new Date().toISOString()
              });
            } catch (e) {
              console.error('[API vinyl/seller] Failed to update user roles:', e);
            }
          }
        }

        return new Response(JSON.stringify({ success: true, message: 'Seller updated' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      case 'suspend': {
        if (collection === 'users') {
          await updateDocument('users', sellerId, {
            suspended: true,
            'roles.vinylSeller': false,
            updatedAt: new Date().toISOString()
          });
        } else {
          await updateDocument('vinylSellers', sellerId, {
            suspended: true,
            suspendedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });

          // Update user's role
          try {
            const userId = seller.userId || sellerId;
            await updateDocument('users', userId, {
              'roles.vinylSeller': false,
              updatedAt: new Date().toISOString()
            });
          } catch (e) {
            console.error('[API vinyl/seller] Failed to update user roles:', e);
          }
        }

        // Update all their listings to removed status
        try {
          const listings = await queryCollection('vinylListings', {
            filters: [{ field: 'sellerId', op: 'EQUAL', value: sellerId }]
          });

          for (const listing of listings) {
            if (listing.status === 'published') {
              await updateDocument('vinylListings', listing.id, {
                status: 'removed',
                removedReason: 'Seller suspended',
                updatedAt: new Date().toISOString()
              });
            }
          }
        } catch (e) {
          console.error('[API vinyl/seller] Failed to update listings:', e);
        }

        return new Response(JSON.stringify({ success: true, message: 'Seller suspended' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      case 'unsuspend': {
        const isApproved = collection === 'users'
          ? (seller.approved || seller.partnerInfo?.approved)
          : seller.approved;

        if (collection === 'users') {
          await updateDocument('users', sellerId, {
            suspended: false,
            disabled: false,
            'roles.vinylSeller': isApproved ? true : false,
            updatedAt: new Date().toISOString()
          });
        } else {
          await updateDocument('vinylSellers', sellerId, {
            suspended: false,
            unsuspendedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });

          // Restore user's role if they're still approved
          if (isApproved) {
            try {
              const userId = seller.userId || sellerId;
              await updateDocument('users', userId, {
                'roles.vinylSeller': true,
                updatedAt: new Date().toISOString()
              });
            } catch (e) {
              console.error('[API vinyl/seller] Failed to update user roles:', e);
            }
          }
        }

        return new Response(JSON.stringify({ success: true, message: 'Seller unsuspended' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      case 'delete': {
        // Soft delete - mark as deleted
        await updateDocument('vinylSellers', sellerId, {
          deleted: true,
          deletedAt: new Date().toISOString(),
          approved: false,
          suspended: true,
          updatedAt: new Date().toISOString()
        });

        // Remove user's role
        try {
          const userId = seller.userId || sellerId;
          await updateDocument('users', userId, {
            'roles.vinylSeller': false,
            updatedAt: new Date().toISOString()
          });
        } catch (e) {
          console.error('[API vinyl/seller] Failed to update user roles:', e);
        }

        return new Response(JSON.stringify({ success: true, message: 'Seller deleted' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      default:
        return new Response(JSON.stringify({ success: false, error: 'Invalid action' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
    }
  } catch (error) {
    console.error('[API vinyl/seller] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
