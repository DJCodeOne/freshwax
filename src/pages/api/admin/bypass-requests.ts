// src/pages/api/admin/bypass-requests.ts
// Handle DJ bypass requests - DJs can request immediate access to go live
import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, queryCollection, deleteDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

// Helper to generate a unique ID
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

// GET - List all pending bypass requests (admin) OR check status for specific user
export const GET: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  try {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const userId = url.searchParams.get('userId');

    // Check status for a specific user
    if (action === 'status' && userId) {
      try {
        const snapshot = await queryCollection('bypassRequests', {
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
      } catch (queryError: any) {
        console.warn('[bypass-requests] Status check query error:', queryError.message);
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
      const snapshot = await queryCollection('bypassRequests', {
        filters: [
          { field: 'status', op: 'EQUAL', value: 'pending' }
        ],
        orderBy: { field: 'createdAt', direction: 'DESCENDING' },
        limit: 50,
        skipCache: true
      });

      // Enrich requests with user data and mix stats
      const requests = await Promise.all(snapshot.map(async (data: any) => {
        const userId = data.userId;

        // Get user profile for name/email
        let djName = data.userName || 'Unknown DJ';
        let email = data.userEmail || '';

        try {
          // Try to get more details from users collection
          const userDoc = await getDocument('users', userId);
          if (userDoc) {
            djName = userDoc.displayName || userDoc.name || djName;
            email = userDoc.email || email;
          }

          // Also check artists collection
          if (!email || djName === 'Unknown DJ') {
            const artistDoc = await getDocument('artists', userId);
            if (artistDoc) {
              djName = artistDoc.name || artistDoc.djName || djName;
              email = artistDoc.email || email;
            }
          }
        } catch (e) {
          // Ignore errors fetching user data
        }

        // Get mix stats
        let mixCount = 0;
        let bestMixLikes = 0;

        try {
          const mixesSnapshot = await queryCollection('dj-mixes', {
            filters: [
              { field: 'userId', op: 'EQUAL', value: userId }
            ],
            skipCache: true
          });

          mixCount = mixesSnapshot.length;
          mixesSnapshot.forEach((mixData: any) => {
            const likes = mixData.likeCount || mixData.likes || 0;
            if (likes > bestMixLikes) bestMixLikes = likes;
          });
        } catch (e) {
          // Ignore errors fetching mix data
        }

        return {
          ...data,
          djName,
          email,
          mixCount,
          bestMixLikes,
          requestedAt: data.createdAt // Alias for consistency
        };
      }));

      return new Response(JSON.stringify({
        success: true,
        requests
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (queryError: any) {
      console.warn('[bypass-requests] List query error:', queryError.message);
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
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch requests'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST - Create a new bypass request OR approve/deny a request
export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  try {
    const body = await request.json();
    const { action, requestId, userId, userEmail, userName, email, djName, requestType, reason, stationName, relayUrl, mixCount, bestMixLikes } = body;

    // Admin action: approve, deny, or expire
    if (action === 'approve' || action === 'deny' || action === 'expire') {
      if (!requestId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Request ID required'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Get the request
      const existingRequest = await getDocument('bypassRequests', requestId);
      if (!existingRequest) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Request not found'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
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
          } catch (userUpdateError: any) {
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

    // User action: create new request
    if (!userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User ID required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check if user already has a pending request
    let existingRequests: any[] = [];
    try {
      existingRequests = await queryCollection('bypassRequests', {
        filters: [
          { field: 'userId', op: 'EQUAL', value: userId },
          { field: 'status', op: 'EQUAL', value: 'pending' }
        ],
        limit: 1,
        skipCache: true
      });
    } catch (queryError: any) {
      console.warn('[bypass-requests] Check existing query error:', queryError.message);
      // Continue - allow request even if we can't check for duplicates
    }

    if (existingRequests.length > 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'You already have a pending request'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Create new request
    const newRequestId = generateId();
    const newRequest = {
      userId,
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
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to process request'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// DELETE - Remove a bypass request
export const DELETE: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  try {
    const url = new URL(request.url);
    const requestId = url.searchParams.get('id');

    if (!requestId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Request ID required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
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
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to delete request'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
