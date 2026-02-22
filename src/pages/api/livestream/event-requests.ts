// src/pages/api/livestream/event-requests.ts
// Manage extended streaming hour requests for events
import type { APIRoute } from 'astro';
import { getDocument, addDocument, updateDocument, queryCollection } from '../../../lib/firebase-rest';
import type { EventRequest } from '../../../lib/subscription';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors, createLogger, successResponse } from '../../../lib/api-utils';

const log = createLogger('livestream/event-requests');
import { z } from 'zod';

const EventRequestSchema = z.object({
  action: z.enum(['create', 'approve', 'reject']),
  // create fields
  userId: z.string().max(200).nullish(),
  userEmail: z.string().max(500).nullish(),
  userName: z.string().max(200).nullish(),
  eventName: z.string().max(500).nullish(),
  eventDescription: z.string().max(5000).nullish(),
  eventDate: z.string().max(50).nullish(),
  hoursRequested: z.number().int().min(1).max(12).nullish(),
  // approve/reject fields
  requestId: z.string().max(200).nullish(),
  adminId: z.string().max(200).nullish(),
  reason: z.string().max(2000).nullish(),
}).passthrough();

export const prerender = false;

// GET: List event requests (for admin) or user's own requests
export const GET: APIRoute = async ({ request, url, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`event-requests:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    const userId = url.searchParams.get('userId');
    const status = url.searchParams.get('status'); // pending, approved, rejected, all
    const adminView = url.searchParams.get('admin') === 'true';

    let requests: Record<string, unknown>[];

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

    return successResponse({ requests });

  } catch (error: unknown) {
    log.error('GET error:', error);
    return ApiErrors.serverError('Failed to fetch event requests');
  }
};

// POST: Create new event request or update existing (approve/reject)
export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: standard API - 60 per minute
  const clientId2 = getClientId(request);
  const rateLimit2 = checkRateLimit(`event-requests-write:${clientId2}`, RateLimiters.standard);
  if (!rateLimit2.allowed) {
    return rateLimitResponse(rateLimit2.retryAfter!);
  }

  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return ApiErrors.badRequest('Invalid JSON body');
    }

    const parseResult = EventRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const body = parseResult.data;
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

      return successResponse({ requestId: docRef.id,
        message: 'Event request submitted successfully' });
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

      return successResponse({ message: `Approved ${existingRequest.hoursRequested} hours for ${existingRequest.userName} on ${existingRequest.eventDate}` });
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

      return successResponse({ message: 'Request rejected' });
    }

    return ApiErrors.badRequest('Invalid action');

  } catch (error: unknown) {
    log.error('POST error:', error);
    return ApiErrors.serverError('Failed to process request');
  }
};
