// src/pages/api/delete-release.ts
// Deletes a release from Firebase (releases collection + master list)
import type { APIRoute } from 'astro';
import { getDocument, queryCollection, initFirebaseEnv } from '../../lib/firebase-rest';
import { saDeleteDocument, saUpdateDocument } from '../../lib/firebase-service-account';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
  warn: (...args: any[]) => isDev && console.warn(...args),
};

// Build service account key from individual env vars
function getServiceAccountKey(env: any): string | null {
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) return null;

  return JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'auto',
    private_key: privateKey.replace(/\\n/g, '\n'),
    client_email: clientEmail,
    client_id: '',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token'
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: destructive operations - 3 per hour
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`delete-release:${clientId}`, RateLimiters.destructive);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  try {
    // Initialize Firebase environment
    const env = (locals as any)?.runtime?.env || {};
    initFirebaseEnv({
      FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
      FIREBASE_API_KEY: env.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
    });

    const body = await request.json();
    const { releaseId } = body;

    if (!releaseId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'releaseId is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    log.info(`[delete-release] Deleting: ${releaseId}`);

    // Get service account key for writes
    const serviceAccountKey = getServiceAccountKey(env);
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      log.error('[delete-release] Service account not configured');
      return new Response(JSON.stringify({
        success: false,
        error: 'Service account not configured'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Verify release exists
    const releaseDoc = await getDocument('releases', releaseId);

    if (!releaseDoc) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Release not found',
        releaseId: releaseId
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const releaseData = releaseDoc;

    // Delete the release document using service account auth
    await saDeleteDocument(serviceAccountKey, projectId, 'releases', releaseId);

    // Delete associated tracks
    try {
      const tracks = await queryCollection('tracks', {
        filters: [{ field: 'releaseId', op: 'EQUAL', value: releaseId }],
        skipCache: true
      });

      if (tracks.length > 0) {
        // Delete each track individually using service account auth
        for (const track of tracks) {
          await saDeleteDocument(serviceAccountKey, projectId, 'tracks', track.id);
        }
        log.info(`[delete-release] Deleted ${tracks.length} associated tracks`);
      }
    } catch (error) {
      log.warn('[delete-release] Could not delete tracks:', error);
    }

    // Remove from master list
    try {
      const masterListDoc = await getDocument('system', 'releases-master');

      if (masterListDoc) {
        const releasesList = masterListDoc.releases || [];
        const updatedReleases = releasesList.filter((r: any) => r.id !== releaseId);

        await saUpdateDocument(serviceAccountKey, projectId, 'system', 'releases-master', {
          releases: updatedReleases,
          totalReleases: updatedReleases.length,
          lastUpdated: new Date().toISOString()
        });
      }
    } catch (error) {
      log.warn('[delete-release] Could not update master list:', error);
    }

    log.info(`[delete-release] Deleted: ${releaseData?.artistName} - ${releaseData?.releaseName}`);

    return new Response(JSON.stringify({
      success: true,
      message: 'Release deleted successfully',
      releaseId: releaseId,
      releaseName: releaseData?.releaseName,
      artistName: releaseData?.artistName
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    log.error('[delete-release] Error:', error instanceof Error ? error.message : 'Unknown error');

    return new Response(JSON.stringify({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};