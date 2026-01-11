// src/pages/api/approve-release.js
// Approves or rejects pending releases in Firebase
import { getDocument, updateDocument, initFirebaseEnv, invalidateReleasesCache } from '../../lib/firebase-rest.js';
import { d1UpsertRelease } from '../../lib/d1-catalog.ts';

export const prerender = false;

const isDev = import.meta.env.DEV;
const log = {
  info: (...args) => isDev && console.log(...args),
  error: (...args) => console.error(...args),
};

export async function POST({ request, locals }) {
  // Initialize Firebase env for write operations (Cloudflare runtime)
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const body = await request.json();
    const { releaseId, action } = body;

    // Validate input
    if (!releaseId || !action) {
      return new Response(JSON.stringify({
        success: false,
        error: 'releaseId and action are required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!['approve', 'reject'].includes(action)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'action must be "approve" or "reject"'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    log.info(`[approve-release] ${action} release ${releaseId}`);

    // Get release from Firestore
    const releaseData = await getDocument('releases', releaseId);

    if (!releaseData) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Release not found',
        releaseId: releaseId
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Update release status
    const updateData = {
      status: action === 'approve' ? 'live' : 'rejected',
      published: action === 'approve',
      approvedAt: action === 'approve' ? new Date().toISOString() : null,
      rejectedAt: action === 'reject' ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString()
    };

    await updateDocument('releases', releaseId, updateData);

    // Update master list
    try {
      const masterListDoc = await getDocument('system', 'releases-master');

      if (masterListDoc) {
        const releasesList = masterListDoc.releases || [];

        const releaseIndex = releasesList.findIndex(r => r.id === releaseId);
        if (releaseIndex >= 0) {
          releasesList[releaseIndex] = {
            ...releasesList[releaseIndex],
            status: updateData.status,
            published: updateData.published,
            updatedAt: updateData.updatedAt
          };

          await updateDocument('system', 'releases-master', {
            releases: releasesList,
            lastUpdated: new Date().toISOString()
          });
        }
      }
    } catch (error) {
      log.error('[approve-release] Warning: Could not update master list:', error.message);
    }

    // Sync to D1 for immediate visibility
    const db = env?.DB;
    if (db) {
      try {
        const updatedRelease = { ...releaseData, ...updateData };
        await d1UpsertRelease(db, releaseId, updatedRelease);
        log.info('[approve-release] D1 synced');
      } catch (d1Error) {
        log.error('[approve-release] Warning: D1 sync failed:', d1Error.message);
      }
    }

    // Invalidate cache to ensure fresh data
    invalidateReleasesCache();
    log.info('[approve-release] Cache invalidated');

    log.info(`[approve-release] ${action}d: ${releaseData.artistName} - ${releaseData.releaseName}`);

    return new Response(JSON.stringify({
      success: true,
      message: `Release ${action}d successfully`,
      releaseId: releaseId,
      status: updateData.status,
      releaseName: releaseData.releaseName,
      artistName: releaseData.artistName
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    log.error('[approve-release] Error:', error.message);

    return new Response(JSON.stringify({
      success: false,
      error: 'Internal server error',
      message: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
