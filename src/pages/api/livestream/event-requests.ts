// src/pages/api/livestream/event-requests.ts
// Manage extended streaming hour requests for events
import type { APIRoute } from 'astro';
import { getDocument, addDocument, updateDocument, queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';
import type { EventRequest } from '../../../lib/subscription';

export const prerender = false;

function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

// GET: List event requests (for admin) or user's own requests
export const GET: APIRoute = async ({ request, url, locals }) => {
  initFirebase(locals);

  try {
    const userId = url.searchParams.get('userId');
    const status = url.searchParams.get('status'); // pending, approved, rejected, all
    const adminView = url.searchParams.get('admin') === 'true';

    let requests: any[];

    if (adminView) {
      // SECURITY: Require admin authentication for viewing all requests
      const { requireAdminAuth, initAdminEnv } = await import('../../../lib/admin');
      const env = (locals as any)?.runtime?.env;
      initAdminEnv({
        ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
        ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
      });

      const authError = requireAdminAuth(request, locals);
      if (authError) {
        return authError;
      }

      // Admin sees all requests, optionally filtered by status
      if (status && status !== 'all') {
        requests = await queryCollection('event-requests', {
          filters: [{ field: 'status', op: 'EQUAL', value: status }],
          orderBy: { field: 'createdAt', direction: 'DESCENDING' },
          limit: 100
        });
      } else {
        requests = await queryCollection('event-requests', {
          orderBy: { field: 'createdAt', direction: 'DESCENDING' },
          limit: 100
        });
      }
    } else if (userId) {
      // User sees their own requests
      requests = await queryCollection('event-requests', {
        filters: [{ field: 'userId', op: 'EQUAL', value: userId }],
        orderBy: { field: 'createdAt', direction: 'DESCENDING' },
        limit: 50
      });
    } else {
      return new Response(JSON.stringify({ success: false, error: 'userId required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ success: true, requests }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[event-requests] GET error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch event requests'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST: Create new event request or update existing (approve/reject)
export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);

  try {
    const body = await request.json();
    const { action } = body;

    // Create new request
    if (action === 'create') {
      const { userId, userEmail, userName, eventName, eventDescription, eventDate, hoursRequested } = body;

      if (!userId || !eventName || !eventDate || !hoursRequested) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing required fields: userId, eventName, eventDate, hoursRequested'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // SECURITY: Verify the requesting user owns this userId
      const authHeader = request.headers.get('Authorization');
      const idToken = authHeader?.replace('Bearer ', '') || undefined;
      const { verifyUserToken } = await import('../../../lib/firebase-rest');

      if (!idToken) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Authentication required'
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const tokenUserId = await verifyUserToken(idToken);
      if (!tokenUserId || tokenUserId !== userId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'You can only create event requests for yourself'
        }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Validate event date is in the future
      const eventDateObj = new Date(eventDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (eventDateObj < today) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Event date must be in the future'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Validate hours (reasonable limit)
      if (hoursRequested < 1 || hoursRequested > 12) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Hours requested must be between 1 and 12'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Check for existing pending request for same date
      const existingRequests = await queryCollection('event-requests', {
        filters: [
          { field: 'userId', op: 'EQUAL', value: userId },
          { field: 'eventDate', op: 'EQUAL', value: eventDate },
          { field: 'status', op: 'EQUAL', value: 'pending' }
        ],
        limit: 1
      });

      if (existingRequests.length > 0) {
        return new Response(JSON.stringify({
          success: false,
          error: 'You already have a pending request for this date'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const newRequest: EventRequest = {
        userId,
        userEmail: userEmail || '',
        userName: userName || 'Unknown',
        eventName,
        eventDescription: eventDescription || '',
        eventDate,
        hoursRequested,
        status: 'pending',
        createdAt: new Date().toISOString()
      };

      const docRef = await addDocument('event-requests', newRequest);

      return new Response(JSON.stringify({
        success: true,
        requestId: docRef.id,
        message: 'Event request submitted successfully'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Approve request (admin action)
    if (action === 'approve') {
      // SECURITY: Require admin authentication for approving requests
      const { requireAdminAuth, initAdminEnv } = await import('../../../lib/admin');
      const env = (locals as any)?.runtime?.env;
      initAdminEnv({
        ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
        ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
      });

      const authError = requireAdminAuth(request, locals);
      if (authError) {
        return authError;
      }

      const { requestId, adminId } = body;

      if (!requestId) {
        return new Response(JSON.stringify({ success: false, error: 'requestId required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const existingRequest = await getDocument('event-requests', requestId);
      if (!existingRequest) {
        return new Response(JSON.stringify({ success: false, error: 'Request not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      await updateDocument('event-requests', requestId, {
        status: 'approved',
        reviewedAt: new Date().toISOString(),
        reviewedBy: adminId || 'admin'
      });

      return new Response(JSON.stringify({
        success: true,
        message: `Approved ${existingRequest.hoursRequested} hours for ${existingRequest.userName} on ${existingRequest.eventDate}`
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Reject request (admin action)
    if (action === 'reject') {
      // SECURITY: Require admin authentication for rejecting requests
      const { requireAdminAuth, initAdminEnv } = await import('../../../lib/admin');
      const env = (locals as any)?.runtime?.env;
      initAdminEnv({
        ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
        ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
      });

      const authError = requireAdminAuth(request, locals);
      if (authError) {
        return authError;
      }

      const { requestId, adminId, reason } = body;

      if (!requestId) {
        return new Response(JSON.stringify({ success: false, error: 'requestId required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const existingRequest = await getDocument('event-requests', requestId);
      if (!existingRequest) {
        return new Response(JSON.stringify({ success: false, error: 'Request not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      await updateDocument('event-requests', requestId, {
        status: 'rejected',
        reviewedAt: new Date().toISOString(),
        reviewedBy: adminId || 'admin',
        rejectionReason: reason || 'Request declined'
      });

      return new Response(JSON.stringify({
        success: true,
        message: 'Request rejected'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ success: false, error: 'Invalid action' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[event-requests] POST error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to process request'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
