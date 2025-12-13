// src/pages/api/delete-release.ts
// Deletes a release from Firebase (releases collection + master list)
import type { APIRoute } from 'astro';
import { getDocument, deleteDocument, queryCollection, updateDocument, initFirebaseEnv } from '../../lib/firebase-rest';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
  warn: (...args: any[]) => isDev && console.warn(...args),
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    // Initialize Firebase environment
    const env = locals?.runtime?.env || {};
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

    // Delete the release document
    await deleteDocument('releases', releaseId);

    // Delete associated tracks
    try {
      const tracks = await queryCollection('tracks', {
        filters: [{ field: 'releaseId', op: 'EQUAL', value: releaseId }],
        skipCache: true
      });

      if (tracks.length > 0) {
        // Delete each track individually
        for (const track of tracks) {
          await deleteDocument('tracks', track.id);
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

        await updateDocument('system', 'releases-master', {
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