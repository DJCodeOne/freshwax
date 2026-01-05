import type { APIRoute } from 'astro';
import { getDocument, updateDocument, initFirebaseEnv } from '../../../../lib/firebase-rest';
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

  // SECURITY: Require admin authentication for viewing listing admin data
  const env = (locals as any)?.runtime?.env;
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });

  const authError = requireAdminAuth(request, locals);
  if (authError) {
    return authError;
  }

  const url = new URL(request.url);
  const listingId = url.searchParams.get('id');

  if (!listingId) {
    return new Response(JSON.stringify({ success: false, error: 'Listing ID required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const listing = await getDocument('vinylListings', listingId);

    if (!listing) {
      return new Response(JSON.stringify({ success: false, error: 'Listing not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ success: true, listing }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('[API vinyl/listing] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Failed to fetch listing' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);

  // SECURITY: Require admin authentication for listing management
  const env = (locals as any)?.runtime?.env;
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });

  const authError = requireAdminAuth(request, locals);
  if (authError) {
    return authError;
  }

  try {
    const body = await request.json();
    const { action, listingId } = body;

    if (!listingId) {
      return new Response(JSON.stringify({ success: false, error: 'Listing ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const listing = await getDocument('vinylListings', listingId);
    if (!listing) {
      return new Response(JSON.stringify({ success: false, error: 'Listing not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    switch (action) {
      case 'update': {
        const updateData: any = { updatedAt: new Date().toISOString() };

        const fields = [
          'artist', 'title', 'label', 'catalogNumber', 'format', 'releaseYear',
          'genre', 'mediaCondition', 'sleeveCondition', 'conditionNotes',
          'price', 'shippingCost', 'status', 'description', 'featured'
        ];

        fields.forEach(field => {
          if (body[field] !== undefined) {
            updateData[field] = body[field];
          }
        });

        await updateDocument('vinylListings', listingId, updateData);

        return new Response(JSON.stringify({ success: true, message: 'Listing updated' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      case 'approve': {
        await updateDocument('vinylListings', listingId, {
          status: 'published',
          approvedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });

        return new Response(JSON.stringify({ success: true, message: 'Listing approved' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      case 'remove': {
        const { reason } = body;

        await updateDocument('vinylListings', listingId, {
          status: 'removed',
          removedAt: new Date().toISOString(),
          removedReason: reason || 'Removed by admin',
          updatedAt: new Date().toISOString()
        });

        return new Response(JSON.stringify({ success: true, message: 'Listing removed' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      case 'delete': {
        await updateDocument('vinylListings', listingId, {
          deleted: true,
          deletedAt: new Date().toISOString(),
          status: 'removed',
          updatedAt: new Date().toISOString()
        });

        return new Response(JSON.stringify({ success: true, message: 'Listing deleted' }), {
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
    console.error('[API vinyl/listing] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
