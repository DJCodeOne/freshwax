import type { APIRoute } from 'astro';
import { getDocument, updateDocument, queryCollection } from '../../../../lib/firebase-rest';

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const sellerId = url.searchParams.get('id');

  if (!sellerId) {
    return new Response(JSON.stringify({ success: false, error: 'Seller ID required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const seller = await getDocument('vinylSellers', sellerId);

    if (!seller) {
      return new Response(JSON.stringify({ success: false, error: 'Seller not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ success: true, seller }), {
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

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { action, sellerId } = body;

    if (!sellerId) {
      return new Response(JSON.stringify({ success: false, error: 'Seller ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Verify seller exists
    const seller = await getDocument('vinylSellers', sellerId);
    if (!seller) {
      return new Response(JSON.stringify({ success: false, error: 'Seller not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    switch (action) {
      case 'update': {
        const { storeName, description, location, discogsUrl, approved, suspended } = body;

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

        return new Response(JSON.stringify({ success: true, message: 'Seller updated' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      case 'suspend': {
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
        await updateDocument('vinylSellers', sellerId, {
          suspended: false,
          unsuspendedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });

        // Restore user's role if they're still approved
        if (seller.approved) {
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
