// src/pages/api/livestream/event-requests.ts
// Manage extended streaming hour requests for events
import type { APIRoute } from 'astro';
import { getDocument, addDocument, updateDocument, queryCollection } from '../../../lib/firebase-rest';
import type { EventRequest } from '../../../lib/subscription';
import { ApiErrors } from '../../../lib/api-utils';

export const prerender = false;

// GET: List event requests (for admin) or user's own requests
export const GET: APIRoute = async ({ request, url, locals }) => {
  try {
    const userId = url.searchParams.get('userId');
    const status = url.searchParams.get('status'); // pending, approved, rejected, all
    const adminView = url.searchParams.get('admin') === 'true';

    let requests: any[];

    if (adminView) {
      // SECURITY: Require admin authentication for viewing all requests
      const { requireAdminAuth, initAdminEnv } = await import('../../../lib/admin');
      const env = locals.runtime.env;
      initAdminEnv({
        ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
        ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
      });

      const authError = await requireAdminAuth(request, locals);
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
      // SECURITY: Verify the requesting user matches the userId
      const { verifyRequestUser } = await import('../../../lib/firebase-rest');
      const { userId: verifiedUserId, error: verifyError } = await verifyRequestUser(request);
      if (verifyError || !verifiedUserId) {
        return ApiErrors.unauthorized('Authentication required');
      }
      if (verifiedUserId !== userId) {
        return ApiErrors.forbidden('You can only view your own event requests');
      }

      // User sees their own requests
      requests = await queryCollection('event-requests', {
        filters: [{ field: 'userId', op: 'EQUAL', value: userId }],
        orderBy: { field: 'createdAt', direction: 'DESCENDING' },
        limit: 50
      });
    } else {
      return ApiErrors.badRequest('userId required');
    }

    return new Response(JSON.stringify({ success: true, requests }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[event-requests] GET error:', error);
    return ApiErrors.serverError('Failed to fetch event requests');
  }
};

// POST: Create new event request or update existing (approve/reject)
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const { action } = body;

    // Create new request
    if (action === 'create') {
      const { userId, userEmail, userName, eventName, eventDescription, eventDate, hoursRequested } = body;

      if (!userId || !eventName || !eventDate || !hoursRequested) {
        return ApiErrors.badRequest('Missing required fields: userId, eventName, eventDate, hoursRequested');
      }

      // SECURITY: Verify the requesting user owns this userId
      const authHeader = request.headers.get('Authorization');
      const idToken = authHeader?.replace('Bearer ', '') || undefined;
      const { verifyUserToken } = await import('../../../lib/firebase-rest');

      if (!idToken) {
        return ApiErrors.unauthorized('Authentication required');
      }
      const tokenUserId = await verifyUserToken(idToken);
      if (!tokenUserId || tokenUserId !== userId) {
        return ApiErrors.forbidden('You can only create event requests for yourself');
      }

      // Validate event date is in the future
      const eventDateObj = new Date(eventDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (eventDateObj < today) {
        return ApiErrors.badRequest('Event date must be in the future');
      }

      // Validate hours (reasonable limit)
      if (hoursRequested < 1 || hoursRequested > 12) {
        return ApiErrors.badRequest('Hours requested must be between 1 and 12');
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
        return ApiErrors.badRequest('You already have a pending request for this date');
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
      const env = locals.runtime.env;
      initAdminEnv({
        ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
        ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
      });

      const authError = await requireAdminAuth(request, locals);
      if (authError) {
        return authError;
      }

      const { requestId, adminId } = body;

      if (!requestId) {
        return ApiErrors.badRequest('requestId required');
      }

      const existingRequest = await getDocument('event-requests', requestId);
      if (!existingRequest) {
        return ApiErrors.notFound('Request not found');
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
      const env = locals.runtime.env;
      initAdminEnv({
        ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
        ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
      });

      const authError = await requireAdminAuth(request, locals);
      if (authError) {
        return authError;
      }

      const { requestId, adminId, reason } = body;

      if (!requestId) {
        return ApiErrors.badRequest('requestId required');
      }

      const existingRequest = await getDocument('event-requests', requestId);
      if (!existingRequest) {
        return ApiErrors.notFound('Request not found');
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

    return ApiErrors.badRequest('Invalid action');

  } catch (error) {
    console.error('[event-requests] POST error:', error);
    return ApiErrors.serverError('Failed to process request');
  }
};
