// src/pages/api/admin/bypass-requests.ts
// Handle DJ bypass requests - DJs can request immediate access to go live
import type { APIRoute } from 'astro';
import { getDocument, setDocument, queryCollection, deleteDocument } from '../../../lib/firebase-rest';

export const prerender = false;

const ADMIN_KEY = import.meta.env.ADMIN_API_KEY || 'fresh-wax-admin-2024';

// GET - List bypass requests or check user's request status
export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const userId = url.searchParams.get('userId');
  
  try {
    // Check specific user's request status
    if (action === 'status' && userId) {
      const request = await getDocument('djBypassRequests', userId);
      
      return new Response(JSON.stringify({
        success: true,
        hasRequest: !!request,
        request: request || null,
        status: request?.status || null
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // List all pending requests (admin only)
    if (action === 'list') {
      const requests = await queryCollection('djBypassRequests', {
        filters: [{ field: 'status', op: 'EQUAL', value: 'pending' }],
        orderBy: { field: 'requestedAt', direction: 'DESCENDING' }
      });
      
      return new Response(JSON.stringify({
        success: true,
        requests: requests || []
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // List all requests including approved/denied
    if (action === 'list-all') {
      const requests = await queryCollection('djBypassRequests', {
        orderBy: { field: 'requestedAt', direction: 'DESCENDING' },
        limit: 50
      });
      
      return new Response(JSON.stringify({
        success: true,
        requests: requests || []
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({
      success: false,
      error: 'Invalid action'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error: any) {
    console.error('[bypass-requests] GET error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to get bypass requests'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST - Submit, approve, deny, or cancel bypass requests
export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { action, userId, reason, djName, email, adminKey, adminEmail, mixCount, bestMixLikes } = body;
    
    // DJ submitting a request
    if (action === 'request') {
      if (!userId || !djName) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing required fields'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Check if already has a pending request
      const existing = await getDocument('djBypassRequests', userId);
      if (existing && existing.status === 'pending') {
        return new Response(JSON.stringify({
          success: false,
          error: 'You already have a pending request'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Check if already has bypass
      const bypass = await getDocument('djLobbyBypass', userId);
      if (bypass) {
        return new Response(JSON.stringify({
          success: false,
          error: 'You already have bypass access'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Create the request
      await setDocument('djBypassRequests', userId, {
        userId,
        djName,
        email: email || null,
        reason: reason || null,
        mixCount: mixCount || 0,
        bestMixLikes: bestMixLikes || 0,
        status: 'pending',
        requestedAt: new Date().toISOString()
      });
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Bypass request submitted successfully'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Admin actions require admin key
    if (!adminKey || adminKey !== ADMIN_KEY) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Admin approving a request
    if (action === 'approve') {
      if (!userId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing userId'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Get the request
      const request = await getDocument('djBypassRequests', userId);
      if (!request) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Request not found'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Grant the bypass
      await setDocument('djLobbyBypass', userId, {
        userId,
        email: request.email || null,
        name: request.djName || null,
        reason: `Bypass request approved${reason ? ': ' + reason : ''}`,
        grantedAt: new Date().toISOString(),
        grantedBy: adminEmail || 'admin'
      });
      
      // Update the request status
      await setDocument('djBypassRequests', userId, {
        ...request,
        status: 'approved',
        approvedAt: new Date().toISOString(),
        approvedBy: adminEmail || 'admin',
        approvalNote: reason || null
      });
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Bypass request approved'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Admin denying a request
    if (action === 'deny') {
      if (!userId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing userId'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Get the request
      const request = await getDocument('djBypassRequests', userId);
      if (!request) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Request not found'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Update the request status
      await setDocument('djBypassRequests', userId, {
        ...request,
        status: 'denied',
        deniedAt: new Date().toISOString(),
        deniedBy: adminEmail || 'admin',
        denialReason: reason || null
      });
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Bypass request denied'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // DJ canceling their own request
    if (action === 'cancel') {
      if (!userId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing userId'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      await deleteDocument('djBypassRequests', userId);
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Bypass request cancelled'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({
      success: false,
      error: 'Invalid action'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error: any) {
    console.error('[bypass-requests] POST error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to process bypass request'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
