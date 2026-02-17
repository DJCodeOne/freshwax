// src/pages/api/admin/fix-release-owner.ts
// Fix release submittedBy field to link to correct artist

import type { APIRoute } from 'astro';
import { getDocument } from '../../../lib/firebase-rest';
import { saUpdateDocument } from '../../../lib/firebase-service-account';
import { requireAdminAuth, initAdminEnv } from '../../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { ApiErrors } from '../../../lib/api-utils';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`fix-release-owner:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);
  const env = locals.runtime.env;
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    return ApiErrors.serverError('Service account not configured');
  }

  const serviceAccountKey = JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'auto',
    private_key: privateKey.replace(/\\n/g, '\n'),
    client_email: clientEmail,
    client_id: '',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token'
  });

  try {
    const body = await request.json();
    initAdminEnv({ ADMIN_UIDS: env?.ADMIN_UIDS, ADMIN_EMAILS: env?.ADMIN_EMAILS });
    const authError = await requireAdminAuth(request, locals, body);
    if (authError) return authError;

    const { releaseId, newOwnerId } = body;

    if (!releaseId || !newOwnerId) {
      return ApiErrors.badRequest('Missing releaseId or newOwnerId');
    }

    // Get the release to verify it exists
    const release = await getDocument('releases', releaseId);
    if (!release) {
      return ApiErrors.notFound('Release not found');
    }

    // Get the artist to verify they exist
    const artist = await getDocument('artists', newOwnerId);
    if (!artist) {
      return ApiErrors.notFound('Artist not found');
    }

    // Update the release with all ownership fields
    await saUpdateDocument(serviceAccountKey, projectId, 'releases', releaseId, {
      submittedBy: newOwnerId,
      submitterId: newOwnerId,
      artistId: newOwnerId,
      submitterEmail: artist.email,
      updatedAt: new Date().toISOString()
    });

    return new Response(JSON.stringify({
      success: true,
      message: 'Release owner updated',
      release: {
        id: releaseId,
        title: release.releaseName || release.title,
        previousOwner: release.submittedBy || '(none)',
        newOwner: newOwnerId,
        artistName: artist.artistName || artist.name
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    console.error('[fix-release-owner] Error:', error);
    return ApiErrors.serverError('Unknown error');
  }
};
