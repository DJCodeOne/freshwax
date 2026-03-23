// src/pages/api/admin/debug-update-user.ts
// Debug endpoint to directly update user roles with verbose logging

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { fetchWithTimeout, ApiErrors, successResponse, jsonResponse } from '../../../lib/api-utils';
import { getAdminFirebaseContext } from '../../../lib/firebase/admin-context';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`debug-update-user:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  // Require admin authentication
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const url = new URL(request.url);
  const userId = url.searchParams.get('userId') || 'JueT7q9eKjQk4iFRg2tXa4ZP8642';
  const confirm = url.searchParams.get('confirm');

  const fbCtx = getAdminFirebaseContext(locals);
  if (fbCtx instanceof Response) return fbCtx;
  const { projectId } = fbCtx;

  try {
    const token = await fbCtx.getToken();
    const docUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}`;

    // First, GET the current document
    const getResponse = await fetchWithTimeout(docUrl, {
      headers: { 'Authorization': `Bearer ${token}` }
    }, 10000);
    if (!getResponse.ok) {
      return ApiErrors.serverError(`Failed to fetch user document: ${getResponse.status}`);
    }
    const currentDoc = await getResponse.json() as Record<string, unknown>;

    // Extract current roles
    const currentRoles: Record<string, unknown> = {};
    const rolesField = ((currentDoc.fields as Record<string, unknown>)?.roles as Record<string, unknown>)?.mapValue as Record<string, unknown>;
    const rolesFields = (rolesField?.fields || {}) as Record<string, Record<string, unknown>>;
    for (const [k, v] of Object.entries(rolesFields)) {
      currentRoles[k] = v.booleanValue;
    }

    if (confirm !== 'yes') {
      return jsonResponse({
        message: 'Current state (add &confirm=yes to update)',
        userId,
        currentRoles,
        willSetArtistTo: false
      });
    }

    // Build new roles with artist=false
    const newRoles = { ...currentRoles, artist: false };

    // Build Firestore value for roles map
    const rolesMapFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(newRoles)) {
      rolesMapFields[k] = { booleanValue: v };
    }

    // PATCH the document
    const patchUrl = `${docUrl}?updateMask.fieldPaths=roles`;
    const patchBody = {
      fields: {
        roles: {
          mapValue: {
            fields: rolesMapFields
          }
        }
      }
    };

    const patchResponse = await fetchWithTimeout(patchUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(patchBody)
    }, 10000);

    if (!patchResponse.ok) {
      return ApiErrors.serverError('PATCH failed');
    }

    const patchResult = await patchResponse.json();

    // Verify by fetching again
    const verifyResponse = await fetchWithTimeout(docUrl, {
      headers: { 'Authorization': `Bearer ${token}` }
    }, 10000);
    if (!verifyResponse.ok) {
      return ApiErrors.serverError(`Failed to verify update: ${verifyResponse.status}`);
    }
    const verifyDoc = await verifyResponse.json() as Record<string, unknown>;

    const verifyRoles: Record<string, unknown> = {};
    const verifyRolesMap = ((verifyDoc.fields as Record<string, unknown>)?.roles as Record<string, unknown>)?.mapValue as Record<string, unknown>;
    const verifyRolesField = (verifyRolesMap?.fields || {}) as Record<string, Record<string, unknown>>;
    for (const [k, v] of Object.entries(verifyRolesField)) {
      verifyRoles[k] = v.booleanValue;
    }

    return successResponse({ message: 'Update complete',
      before: currentRoles,
      requested: newRoles,
      after: verifyRoles,
      artistNowFalse: verifyRoles.artist === false
    });

  } catch (error: unknown) {
    return ApiErrors.serverError('Unknown error');
  }
};
