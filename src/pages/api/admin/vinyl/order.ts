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

  // SECURITY: Require admin authentication for viewing order data
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
  const orderId = url.searchParams.get('id');

  if (!orderId) {
    return new Response(JSON.stringify({ success: false, error: 'Order ID required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const order = await getDocument('vinylOrders', orderId);

    if (!order) {
      return new Response(JSON.stringify({ success: false, error: 'Order not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ success: true, order }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('[API vinyl/order] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Failed to fetch order' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);

  // SECURITY: Require admin authentication for order management
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
    const { action, orderId } = body;

    if (!orderId) {
      return new Response(JSON.stringify({ success: false, error: 'Order ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const order = await getDocument('vinylOrders', orderId);
    if (!order) {
      return new Response(JSON.stringify({ success: false, error: 'Order not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    switch (action) {
      case 'update-status': {
        const { status } = body;
        const validStatuses = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];

        if (!validStatuses.includes(status)) {
          return new Response(JSON.stringify({ success: false, error: 'Invalid status' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const updateData: any = {
          status,
          updatedAt: new Date().toISOString()
        };

        // Add timestamp for status change
        if (status === 'paid') updateData.paidAt = new Date().toISOString();
        if (status === 'shipped') updateData.shippedAt = new Date().toISOString();
        if (status === 'delivered') updateData.deliveredAt = new Date().toISOString();
        if (status === 'cancelled') updateData.cancelledAt = new Date().toISOString();

        await updateDocument('vinylOrders', orderId, updateData);

        return new Response(JSON.stringify({ success: true, message: 'Order status updated' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      case 'add-tracking': {
        const { carrier, trackingNumber } = body;

        await updateDocument('vinylOrders', orderId, {
          carrier: carrier || '',
          trackingNumber: trackingNumber || '',
          updatedAt: new Date().toISOString()
        });

        return new Response(JSON.stringify({ success: true, message: 'Tracking info updated' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      case 'refund': {
        // Mark order as refunded
        await updateDocument('vinylOrders', orderId, {
          status: 'refunded',
          refundedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });

        // TODO: Integrate with payment processor for actual refund
        // For now, just update the status

        return new Response(JSON.stringify({ success: true, message: 'Order marked as refunded' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      case 'add-note': {
        const { note, adminId } = body;

        const notes = order.adminNotes || [];
        notes.push({
          note,
          adminId,
          createdAt: new Date().toISOString()
        });

        await updateDocument('vinylOrders', orderId, {
          adminNotes: notes,
          updatedAt: new Date().toISOString()
        });

        return new Response(JSON.stringify({ success: true, message: 'Note added' }), {
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
    console.error('[API vinyl/order] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
