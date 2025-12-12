// src/pages/api/admin/bypass-requests.ts
// Handle DJ bypass requests - DJs can request immediate access to go live
import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export const prerender = false;

// Initialize Firebase Admin
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store',
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

// Helper to generate a unique ID
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

// GET - List all pending bypass requests (admin) OR check status for specific user
export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const userId = url.searchParams.get('userId');
    
    // Check status for a specific user
    if (action === 'status' && userId) {
      try {
        const snapshot = await db.collection('bypassRequests')
          .where('userId', '==', userId)
          .orderBy('createdAt', 'desc')
          .limit(5)
          .get();
        
        const userRequests = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        }));
        
        // Find the most recent pending, approved, or denied request
        const pendingRequest = userRequests.find((r: any) => r.status === 'pending');
        const approvedRequest = userRequests.find((r: any) => r.status === 'approved');
        const deniedRequest = userRequests.find((r: any) => r.status === 'denied');
        
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
      const snapshot = await db.collection('bypassRequests')
        .where('status', '==', 'pending')
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get();
      
      // Enrich requests with user data and mix stats
      const requests = await Promise.all(snapshot.docs.map(async doc => {
        const data = doc.data();
        const userId = data.userId;
        
        // Get user profile for name/email
        let djName = data.userName || 'Unknown DJ';
        let email = data.userEmail || '';
        
        try {
          // Try to get more details from users collection
          const userDoc = await db.collection('users').doc(userId).get();
          if (userDoc.exists) {
            const userData = userDoc.data();
            djName = userData?.displayName || userData?.name || djName;
            email = userData?.email || email;
          }
          
          // Also check artists collection
          if (!email || djName === 'Unknown DJ') {
            const artistDoc = await db.collection('artists').doc(userId).get();
            if (artistDoc.exists) {
              const artistData = artistDoc.data();
              djName = artistData?.name || artistData?.djName || djName;
              email = artistData?.email || email;
            }
          }
        } catch (e) {
          // Ignore errors fetching user data
        }
        
        // Get mix stats
        let mixCount = 0;
        let bestMixLikes = 0;
        
        try {
          const mixesSnapshot = await db.collection('dj-mixes')
            .where('userId', '==', userId)
            .get();
          
          mixCount = mixesSnapshot.size;
          mixesSnapshot.docs.forEach(mixDoc => {
            const mixData = mixDoc.data();
            const likes = mixData.likeCount || mixData.likes || 0;
            if (likes > bestMixLikes) bestMixLikes = likes;
          });
        } catch (e) {
          // Ignore errors fetching mix data
        }
        
        return {
          id: doc.id,
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
export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { action, requestId, userId, userEmail, userName, email, djName, requestType, reason, mixCount, bestMixLikes } = body;

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
      const requestDoc = await db.collection('bypassRequests').doc(requestId).get();
      if (!requestDoc.exists) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Request not found' 
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const existingRequest = requestDoc.data();
      
      // Handle expire action
      if (action === 'expire') {
        await db.collection('bypassRequests').doc(requestId).update({
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
        const targetUserId = existingRequest?.userId;
        const targetRequestType = existingRequest?.requestType || 'go-live';
        const userEmail = existingRequest?.userEmail || '';
        const userName = existingRequest?.userName || '';
        
        if (targetUserId) {
          // Update user with bypass permission
          await db.collection('users').doc(targetUserId).set({
            [`${targetRequestType}Bypassed`]: true,
            bypassedAt: new Date().toISOString(),
            bypassedBy: 'admin'
          }, { merge: true });
          
          // Also add to djLobbyBypass collection for the admin list
          await db.collection('djLobbyBypass').doc(targetUserId).set({
            email: userEmail,
            name: userName,
            reason: existingRequest?.reason || 'Approved via bypass request',
            grantedAt: new Date(),
            grantedBy: 'admin'
          });
        }

        // Update request status
        await db.collection('bypassRequests').doc(requestId).update({
          status: 'approved',
          processedAt: new Date().toISOString()
        });

        return new Response(JSON.stringify({ 
          success: true, 
          message: 'Request approved' 
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } else {
        // Deny - just update status
        await db.collection('bypassRequests').doc(requestId).update({
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
      const snapshot = await db.collection('bypassRequests')
        .where('userId', '==', userId)
        .where('status', '==', 'pending')
        .limit(1)
        .get();
      existingRequests = snapshot.docs;
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
      status: 'pending',
      createdAt: new Date().toISOString(),
      // Store mix stats for admin review
      mixCount: mixCount || 0,
      bestMixLikes: bestMixLikes || 0
    };

    await db.collection('bypassRequests').doc(newRequestId).set(newRequest);

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
export const DELETE: APIRoute = async ({ request }) => {
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

    await db.collection('bypassRequests').doc(requestId).delete();

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
