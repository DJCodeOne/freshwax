// src/pages/api/admin/bypass-requests.ts
// Handle DJ bypass requests - DJs can request immediate access to go live
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, setDocument, queryCollection, deleteDocument } from '../../../lib/firebase-rest';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { parseJsonBody, ApiErrors } from '../../../lib/api-utils';
import { getSaQuery } from '../../../lib/admin-query';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

const bypassRequestPostSchema = z.object({
  action: z.enum(['approve', 'deny', 'expire']).optional(),
  requestId: z.string().optional(),
  userId: z.string().optional(),
  userEmail: z.string().optional(),
  userName: z.string().optional(),
  email: z.string().optional(),
  djName: z.string().optional(),
  requestType: z.string().optional(),
  reason: z.string().optional(),
  stationName: z.string().optional(),
  relayUrl: z.string().optional(),
  mixCount: z.number().optional(),
  bestMixLikes: z.number().optional(),
}).passthrough();

export const prerender = false;

// Helper to generate a unique ID
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

// GET - List all pending bypass requests (admin) OR check status for specific user
export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`bypass-requests:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals?.runtime?.env;

  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const saQuery = getSaQuery(locals);
  try {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const userId = url.searchParams.get('userId');

    // Status check: user must be authenticated and can only check their own status
    if (action === 'status' && userId) {
      const { verifyRequestUser } = await import('../../../lib/firebase-rest');
      try {
        const { userId: verifiedId } = await verifyRequestUser(request);
        if (!verifiedId || verifiedId !== userId) {
          return ApiErrors.forbidden('Unauthorized');
        }
      } catch {
        return ApiErrors.unauthorized('Authentication required');
      }
    } else {
      // All other GET actions require admin auth
      const authError = await requireAdminAuth(request, locals);
      if (authError) return authError;
    }

    // Check status for a specific user
    if (action === 'status' && userId) {
      try {
        const snapshot = await saQuery('bypassRequests', {
          filters: [
            { field: 'userId', op: 'EQUAL', value: userId }
          ],
          orderBy: { field: 'createdAt', direction: 'DESCENDING' },
          limit: 5,
          skipCache: true
        });

        // Find the most recent pending, approved, or denied request
        const pendingRequest = snapshot.find((r: any) => r.status === 'pending');
        const approvedRequest = snapshot.find((r: any) => r.status === 'approved');
        const deniedRequest = snapshot.find((r: any) => r.status === 'denied');

        // Determine the current active request (pending takes priority)
        const activeRequest = pendingRequest || approvedRequest || deniedRequest || null;

        return new Response(JSON.stringify({
          success: true,
          hasRequest: !!activeRequest,
          request: activeRequest,
          hasPending: !!pendingRequest,
          hasApproved: !!approvedRequest,
          hasDenied: !!deniedRequest
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (queryError: unknown) {
        console.warn('[bypass-requests] Status check query error:', queryError instanceof Error ? queryError.message : String(queryError));
        // Return empty status on error
        return new Response(JSON.stringify({
          success: true,
          hasRequest: false,
          request: null,
          hasPending: false,
          hasApproved: false,
          hasDenied: false
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Admin: list all pending requests (action=list or no action)
    try {
      const snapshot = await saQuery('bypassRequests', {
        filters: [
          { field: 'status', op: 'EQUAL', value: 'pending' }
        ],
        orderBy: { field: 'createdAt', direction: 'DESCENDING' },
        limit: 50,
        skipCache: true
      });

      // Collect unique user IDs for batch fetching
      const userIds = [...new Set(snapshot.map((r: any) => r.userId).filter(Boolean))];

      // Batch fetch all user data in parallel (not N+1!)
      const [usersData, artistsData, mixesData] = await Promise.all([
        // Fetch all users at once
        Promise.all(userIds.map(id => getDocument('users', id).catch(() => null))),
        // Fetch all artists at once
        Promise.all(userIds.map(id => getDocument('artists', id).catch(() => null))),
        // Fetch all mixes - single query with cache
        queryCollection('dj-mixes', { limit: 500, cacheTime: 60000 }).catch(() => [])
      ]);

      // Build lookup maps for O(1) access
      const usersMap = new Map<string, any>();
      const artistsMap = new Map<string, any>();
      userIds.forEach((id, i) => {
        if (usersData[i]) usersMap.set(id, usersData[i]);
        if (artistsData[i]) artistsMap.set(id, artistsData[i]);
      });

      // Build mix stats map
      const mixStatsMap = new Map<string, { count: number; bestLikes: number }>();
      (mixesData as any[]).forEach((mix: any) => {
        const uid = mix.userId || mix.user_id || mix.uploaderId;
        if (!uid) return;
        const stats = mixStatsMap.get(uid) || { count: 0, bestLikes: 0 };
        stats.count++;
        const likes = mix.likeCount || mix.likes || 0;
        if (likes > stats.bestLikes) stats.bestLikes = likes;
        mixStatsMap.set(uid, stats);
      });

      // Map requests with enriched data (no async, all data is in maps)
      const requests = snapshot.map((data: any) => {
        const userId = data.userId;
        const userDoc = usersMap.get(userId);
        const artistDoc = artistsMap.get(userId);
        const mixStats = mixStatsMap.get(userId) || { count: 0, bestLikes: 0 };

        let djName = data.userName || 'Unknown DJ';
        let email = data.userEmail || '';

        if (userDoc) {
          djName = userDoc.displayName || userDoc.name || djName;
          email = userDoc.email || email;
        }
        if (artistDoc && (!email || djName === 'Unknown DJ')) {
          djName = artistDoc.name || artistDoc.djName || djName;
          email = artistDoc.email || email;
        }

        return {
          ...data,
          djName,
          email,
          mixCount: mixStats.count,
          bestMixLikes: mixStats.bestLikes,
          requestedAt: data.createdAt
        };
      });

      return new Response(JSON.stringify({
        success: true,
        requests
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (queryError: unknown) {
      console.warn('[bypass-requests] List query error:', queryError instanceof Error ? queryError.message : String(queryError));
      return new Response(JSON.stringify({
        success: true,
        requests: []
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch (error) {
    console.error('Error fetching bypass requests:', error);
    return ApiErrors.serverError('Failed to fetch requests');
  }
};

// POST - Create a new bypass request OR approve/deny a request
export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`bypass-requests-write:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals?.runtime?.env;

  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
  const saQuery = getSaQuery(locals);
  try {
    const body = await request.json();

    const parsed = bypassRequestPostSchema.safeParse(body);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { action, requestId, userId, userEmail, userName, email, djName, requestType, reason, stationName, relayUrl, mixCount, bestMixLikes } = parsed.data;

    // Admin action: approve, deny, or expire — REQUIRES admin auth
    if (action === 'approve' || action === 'deny' || action === 'expire') {
      const authError = await requireAdminAuth(request, locals, body);
      if (authError) return authError;

      if (!requestId) {
        return ApiErrors.badRequest('Request ID required');
      }

      // Get the request
      const existingRequest = await getDocument('bypassRequests', requestId);
      if (!existingRequest) {
        return ApiErrors.notFound('Request not found');
      }

      // Handle expire action
      if (action === 'expire') {
        await updateDocument('bypassRequests', requestId, {
          status: 'expired',
          processedAt: new Date().toISOString()
        });

        return new Response(JSON.stringify({
          success: true,
          message: 'Request expired'
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (action === 'approve') {
        // Update user's bypassed status
        const targetUserId = existingRequest.userId;
        const targetRequestType = existingRequest.requestType || 'go-live';
        const userEmail = existingRequest.userEmail || '';
        const userName = existingRequest.userName || '';
        const approvedStationName = existingRequest.stationName || '';
        const approvedRelayUrl = existingRequest.relayUrl || '';

        console.log('[bypass-requests] Approving request:', { requestId, targetUserId, targetRequestType });

        if (targetUserId) {
          try {
            // Update user with bypass permission
            const updateData: any = {
              [`${targetRequestType}Bypassed`]: true,
              bypassedAt: new Date().toISOString(),
              bypassedBy: 'admin'
            };

            // If relay URL was provided, add approved relay data
            if (approvedRelayUrl) {
              updateData.approvedRelay = {
                stationName: approvedStationName,
                relayUrl: approvedRelayUrl,
                approvedAt: new Date().toISOString(),
                approvedBy: 'admin'
              };
            }

            console.log('[bypass-requests] Updating user document...');
            const existingUser = await getDocument('users', targetUserId);
            if (existingUser) {
              await updateDocument('users', targetUserId, updateData);
            } else {
              await setDocument('users', targetUserId, updateData);
            }
            console.log('[bypass-requests] User document updated');

            // Also add to djLobbyBypass collection for the admin list
            const bypassData: any = {
              email: userEmail,
              name: userName,
              reason: existingRequest.reason || 'Approved via bypass request',
              grantedAt: new Date().toISOString(),
              grantedBy: 'admin'
            };

            // Include relay info if provided
            if (approvedRelayUrl) {
              bypassData.stationName = approvedStationName;
              bypassData.relayUrl = approvedRelayUrl;
              bypassData.relayApproved = true;
            }

            console.log('[bypass-requests] Adding to djLobbyBypass...');
            await setDocument('djLobbyBypass', targetUserId, bypassData);
            console.log('[bypass-requests] Added to djLobbyBypass');
          } catch (userUpdateError: unknown) {
            console.error('[bypass-requests] Error updating user:', userUpdateError);
            throw userUpdateError;
          }
        }

        // Update request status
        console.log('[bypass-requests] Updating request status...');
        await updateDocument('bypassRequests', requestId, {
          status: 'approved',
          processedAt: new Date().toISOString()
        });
        console.log('[bypass-requests] Request approved successfully');

        return new Response(JSON.stringify({
          success: true,
          message: 'Request approved'
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } else {
        // Deny - just update status
        await updateDocument('bypassRequests', requestId, {
          status: 'denied',
          processedAt: new Date().toISOString()
        });

        return new Response(JSON.stringify({
          success: true,
          message: 'Request denied'
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // User action: create new request — verify auth
    let verifiedUserId: string | undefined;
    try {
      const { verifyRequestUser } = await import('../../../lib/firebase-rest');
      const { userId: vId } = await verifyRequestUser(request);
      verifiedUserId = vId;
    } catch {
      return ApiErrors.unauthorized('Authentication required');
    }

    if (!verifiedUserId) {
      return ApiErrors.unauthorized('Authentication required');
    }

    // Use verified userId, not body-supplied userId
    const authenticatedUserId = verifiedUserId;

    // Check if user already has a pending request
    let existingRequests: any[] = [];
    try {
      existingRequests = await saQuery('bypassRequests', {
        filters: [
          { field: 'userId', op: 'EQUAL', value: authenticatedUserId },
          { field: 'status', op: 'EQUAL', value: 'pending' }
        ],
        limit: 1,
        skipCache: true
      });
    } catch (queryError: unknown) {
      console.warn('[bypass-requests] Check existing query error:', queryError instanceof Error ? queryError.message : String(queryError));
      // Continue - allow request even if we can't check for duplicates
    }

    if (existingRequests.length > 0) {
      return ApiErrors.badRequest('You already have a pending request');
    }

    // Create new request
    const newRequestId = generateId();
    const newRequest = {
      userId: authenticatedUserId,
      userEmail: userEmail || email || '',
      userName: userName || djName || 'Unknown',
      requestType: requestType || 'go-live',
      reason: reason || '',
      stationName: stationName || '',
      relayUrl: relayUrl || '',
      status: 'pending',
      createdAt: new Date().toISOString(),
      // Store mix stats for admin review
      mixCount: mixCount || 0,
      bestMixLikes: bestMixLikes || 0
    };

    await setDocument('bypassRequests', newRequestId, newRequest);

    return new Response(JSON.stringify({
      success: true,
      message: 'Request submitted successfully',
      requestId: newRequestId
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Error processing bypass request:', error);
    return ApiErrors.serverError('Failed to process request');
  }
};

// DELETE - Remove a bypass request (admin only)
export const DELETE: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`bypass-requests-delete:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const env = locals?.runtime?.env;

  initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });

  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  try {
    const url = new URL(request.url);
    const requestId = url.searchParams.get('id');

    if (!requestId) {
      return ApiErrors.badRequest('Request ID required');
    }

    await deleteDocument('bypassRequests', requestId);

    return new Response(JSON.stringify({
      success: true,
      message: 'Request deleted'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Error deleting bypass request:', error);
    return ApiErrors.serverError('Failed to delete request');
  }
};
