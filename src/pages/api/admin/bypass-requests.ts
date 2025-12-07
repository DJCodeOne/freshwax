// src/pages/api/admin/bypass-requests.ts
// Handle DJ bypass requests - DJs can request immediate access to go live
import type { APIRoute } from 'astro';
import { getDocument, queryCollection } from '../../../lib/firebase-rest';

export const prerender = false;

// Helper to generate a unique ID
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

// Helper to make Firestore REST API calls for writes
async function firestoreWrite(method: 'POST' | 'PATCH' | 'DELETE', path: string, data?: Record<string, any>) {
  const projectId = import.meta.env.FIREBASE_PROJECT_ID;
  const apiKey = import.meta.env.FIREBASE_API_KEY;
  
  if (!projectId || !apiKey) {
    throw new Error('Firebase configuration missing');
  }

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}?key=${apiKey}`;

  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };

  if (data && method !== 'DELETE') {
    const fields: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      fields[key] = convertToFirestoreValue(value);
    }
    options.body = JSON.stringify({ fields });
  }

  const response = await fetch(url, options);
  
  if (!response.ok && response.status !== 404) {
    const error = await response.text();
    throw new Error(`Firestore error: ${response.status} - ${error}`);
  }

  if (method === 'DELETE') {
    return { success: true };
  }

  return response.json();
}

function convertToFirestoreValue(value: any): any {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'boolean') return { booleanValue: value };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(v => convertToFirestoreValue(v)) } };
  }
  if (typeof value === 'object') {
    const mapFields: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      mapFields[k] = convertToFirestoreValue(v);
    }
    return { mapValue: { fields: mapFields } };
  }
  return { stringValue: String(value) };
}

// GET - List all pending bypass requests (admin only)
export const GET: APIRoute = async ({ request }) => {
  try {
    // Query pending requests
    const requests = await queryCollection('bypassRequests', {
      filters: [
        { field: 'status', op: 'EQUAL', value: 'pending' }
      ],
      orderBy: { field: 'createdAt', direction: 'DESCENDING' },
      limit: 50
    });

    return new Response(JSON.stringify({ 
      success: true, 
      requests 
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
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
    const { action, requestId, userId, userEmail, userName, requestType, reason } = body;

    // Admin action: approve or deny
    if (action === 'approve' || action === 'deny') {
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

      if (action === 'approve') {
        // Update user's bypassed status
        const targetUserId = existingRequest.userId;
        const targetRequestType = existingRequest.requestType || 'go-live';
        
        // Get current user data
        const userData = await getDocument('users', targetUserId);
        
        // Update user with bypass permission
        await firestoreWrite('PATCH', `users/${targetUserId}`, {
          ...userData,
          [`${targetRequestType}Bypassed`]: true,
          bypassedAt: new Date().toISOString(),
          bypassedBy: 'admin'
        });

        // Update request status
        await firestoreWrite('PATCH', `bypassRequests/${requestId}`, {
          ...existingRequest,
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
        await firestoreWrite('PATCH', `bypassRequests/${requestId}`, {
          ...existingRequest,
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
    const existingRequests = await queryCollection('bypassRequests', {
      filters: [
        { field: 'userId', op: 'EQUAL', value: userId },
        { field: 'status', op: 'EQUAL', value: 'pending' }
      ],
      limit: 1
    });

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
      userEmail: userEmail || '',
      userName: userName || 'Unknown',
      requestType: requestType || 'go-live',
      reason: reason || '',
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    await firestoreWrite('PATCH', `bypassRequests/${newRequestId}`, newRequest);

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

    await firestoreWrite('DELETE', `bypassRequests/${requestId}`);

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
