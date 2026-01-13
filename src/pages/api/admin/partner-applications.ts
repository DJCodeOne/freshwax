// src/pages/api/admin/partner-applications.ts
import type { APIRoute } from 'astro';
import { getDocument, queryCollection } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { parseJsonBody } from '../../../lib/api-utils';

export const prerender = false;

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

// GET - List pending partner applications
export const GET: APIRoute = async ({ request, locals }) => {
  // Admin authentication
  const body = await parseJsonBody(request);
  const authError = requireAdminAuth(request, locals, body);
  if (authError) return authError;

  try {
    // Query both collections - pendingRoleRequests (from registration) and partnerApplications (legacy)
    const [roleRequests, legacyApplications] = await Promise.all([
      queryCollection('pendingRoleRequests', {
        filters: [
          { field: 'status', op: 'EQUAL', value: 'pending' }
        ],
        orderBy: { field: 'requestedAt', direction: 'DESCENDING' },
        limit: 50
      }).catch(() => []),
      queryCollection('partnerApplications', {
        filters: [
          { field: 'status', op: 'EQUAL', value: 'pending' }
        ],
        orderBy: { field: 'createdAt', direction: 'DESCENDING' },
        limit: 50
      }).catch(() => [])
    ]);

    // Normalize role requests to match expected format
    const normalizedRoleRequests = roleRequests.map((req: any) => ({
      id: req.id,
      userId: req.userId || req.uid,
      email: req.email,
      name: req.displayName || req.artistName || req.businessName || req.storeName,
      artistName: req.artistName,
      businessName: req.businessName,
      storeName: req.storeName,
      type: req.roleType, // 'artist', 'merchSeller', 'vinylSeller'
      partnerType: req.roleType,
      bio: req.bio,
      description: req.description,
      links: req.links,
      website: req.website,
      location: req.location,
      discogsUrl: req.discogsUrl,
      status: req.status,
      createdAt: req.requestedAt || req.createdAt,
      source: 'pendingRoleRequests'
    }));

    // Mark legacy applications with source
    const normalizedLegacy = legacyApplications.map((app: any) => ({
      ...app,
      source: 'partnerApplications'
    }));

    // Combine and sort by date
    const allApplications = [...normalizedRoleRequests, ...normalizedLegacy]
      .sort((a, b) => {
        const dateA = new Date(a.createdAt || 0).getTime();
        const dateB = new Date(b.createdAt || 0).getTime();
        return dateB - dateA;
      });

    return new Response(JSON.stringify({
      success: true,
      applications: allApplications
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error fetching partner applications:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch applications',
      applications: []
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST - Approve or deny application
export const POST: APIRoute = async ({ request, locals }) => {
  // Admin authentication
  const body = await parseJsonBody(request);
  const authError = requireAdminAuth(request, locals, body);
  if (authError) return authError;

  try {
    const { action, applicationId, source } = body;

    if (!applicationId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Application ID required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Try to find in pendingRoleRequests first, then partnerApplications
    let application = await getDocument('pendingRoleRequests', applicationId);
    let collectionName = 'pendingRoleRequests';

    if (!application) {
      application = await getDocument('partnerApplications', applicationId);
      collectionName = 'partnerApplications';
    }

    if (!application) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Application not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Normalize field names from pendingRoleRequests format
    if (collectionName === 'pendingRoleRequests') {
      application = {
        ...application,
        userId: application.userId || application.uid,
        partnerType: application.roleType,
        type: application.roleType,
        artistName: application.artistName || application.displayName,
        businessName: application.businessName || application.storeName,
        createdAt: application.requestedAt || application.createdAt
      };
    }

    if (action === 'approve') {
      // Create partner/user record if needed
      if (application.userId) {
        const userData = await getDocument('users', application.userId) || {};
        const partnerType = application.partnerType || application.type || 'artist';

        // Build the roles object - preserve existing roles and add the new one
        const existingRoles = userData.roles || {};
        const newRoles = { ...existingRoles };

        // Set the appropriate role based on partner type
        if (partnerType === 'artist' || partnerType === 'dj') {
          newRoles.artist = true;
        }
        if (partnerType === 'dj') {
          newRoles.dj = true;
        }
        if (partnerType === 'merchSupplier' || partnerType === 'merch' || partnerType === 'merchSeller') {
          newRoles.merchSupplier = true;
        }
        if (partnerType === 'vinylSeller') {
          newRoles.vinylSeller = true;
        }

        // Update user document with role and approval status
        await firestoreWrite('PATCH', `users/${application.userId}`, {
          ...userData,
          roles: newRoles,
          partnerType: partnerType,
          partnerApproved: true,
          partnerApprovedAt: new Date().toISOString(),
          partnerInfo: {
            ...(userData.partnerInfo || {}),
            approved: true,
            approvedAt: new Date().toISOString(),
            displayName: application.artistName || application.businessName || application.name || userData.displayName || ''
          }
        });

        // Also create/update entry in artists collection for legacy compatibility
        await firestoreWrite('PATCH', `artists/${application.userId}`, {
          id: application.userId,
          userId: application.userId,
          email: application.email || userData.email || '',
          artistName: application.artistName || application.businessName || application.name || '',
          name: application.artistName || application.businessName || application.name || '',
          approved: true,
          approvedAt: new Date().toISOString(),
          createdAt: application.createdAt || new Date().toISOString(),
          isArtist: partnerType === 'artist' || partnerType === 'dj',
          isDJ: partnerType === 'dj',
          isMerchSupplier: partnerType === 'merchSupplier' || partnerType === 'merch'
        });
      }

      // Update application status in the correct collection
      await firestoreWrite('PATCH', `${collectionName}/${applicationId}`, {
        ...application,
        status: 'approved',
        processedAt: new Date().toISOString()
      });

      // Also update the user's pendingRoles if this came from pendingRoleRequests
      if (collectionName === 'pendingRoleRequests' && application.userId) {
        const userData = await getDocument('users', application.userId);
        if (userData?.pendingRoles?.[application.roleType]) {
          const updatedPendingRoles = { ...userData.pendingRoles };
          updatedPendingRoles[application.roleType] = {
            ...updatedPendingRoles[application.roleType],
            status: 'approved',
            approvedAt: new Date().toISOString()
          };
          await firestoreWrite('PATCH', `users/${application.userId}`, {
            pendingRoles: updatedPendingRoles
          });
        }
      }

      return new Response(JSON.stringify({
        success: true,
        message: 'Application approved'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } else if (action === 'deny') {
      await firestoreWrite('PATCH', `${collectionName}/${applicationId}`, {
        ...application,
        status: 'denied',
        processedAt: new Date().toISOString()
      });

      // Also update the user's pendingRoles if this came from pendingRoleRequests
      if (collectionName === 'pendingRoleRequests' && application.userId) {
        const userData = await getDocument('users', application.userId);
        if (userData?.pendingRoles?.[application.roleType]) {
          const updatedPendingRoles = { ...userData.pendingRoles };
          updatedPendingRoles[application.roleType] = {
            ...updatedPendingRoles[application.roleType],
            status: 'denied',
            deniedAt: new Date().toISOString()
          };
          await firestoreWrite('PATCH', `users/${application.userId}`, {
            pendingRoles: updatedPendingRoles
          });
        }
      }

      return new Response(JSON.stringify({ 
        success: true, 
        message: 'Application denied' 
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

  } catch (error) {
    console.error('Error processing application:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Failed to process application' 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
