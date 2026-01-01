// src/pages/api/update-release.ts
// Firebase-based release update API
import { getDocument, updateDocument, initFirebaseEnv } from '../../lib/firebase-rest';

export const prerender = false;

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export async function POST({ request, locals }: any) {
  log.info('[update-release] POST request received');

  try {
    // Initialize Firebase environment
    const env = locals?.runtime?.env || {};
    initFirebaseEnv({
      FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
      FIREBASE_API_KEY: env.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
    });

    const updates = await request.json();
    log.info('[update-release] Request body:', JSON.stringify(updates, null, 2));

    const { id, idToken, ...updateData } = updates;

    // Also check Authorization header for token
    const authHeader = request.headers.get('Authorization');
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const authToken = idToken || bearerToken;

    console.log('[update-release] Auth token received:', authToken ? 'YES (' + authToken.substring(0, 20) + '...)' : 'NO');

    if (!id) {
      log.error('[update-release] No release ID provided');
      return new Response(JSON.stringify({
        error: 'Release ID is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    log.info('[update-release] Updating release:', id);

    // Get release from Firestore
    const releaseDoc = await getDocument('releases', id);

    if (!releaseDoc) {
      log.error('[update-release] Release not found:', id);
      return new Response(JSON.stringify({
        error: 'Release not found',
        id: id
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Clean up undefined values (Firestore doesn't like them)
    const cleanedData: any = {};
    for (const [key, value] of Object.entries(updateData)) {
      if (value !== undefined) {
        cleanedData[key] = value;
      }
    }

    // Add updatedAt timestamp
    cleanedData.updatedAt = new Date().toISOString();

    log.info('[update-release] Cleaned data:', JSON.stringify(cleanedData, null, 2));

    // Update in Firestore (pass auth token for authenticated writes)
    await updateDocument('releases', id, cleanedData, authToken);
    log.info('[update-release] Updated in Firestore');

    // Also update the master list
    try {
      const masterListDoc = await getDocument('system', 'releases-master');

      if (masterListDoc) {
        const releasesList = masterListDoc.releases || [];

        // Find and update the release in master list
        const releaseIndex = releasesList.findIndex((r: any) => r.id === id);
        if (releaseIndex >= 0) {
          // Update summary fields in master list
          releasesList[releaseIndex] = {
            ...releasesList[releaseIndex],
            title: cleanedData.title || releasesList[releaseIndex].title,
            artist: cleanedData.artist || releasesList[releaseIndex].artist,
            coverUrl: cleanedData.coverUrl || releasesList[releaseIndex].coverUrl,
            published: cleanedData.published !== undefined ? cleanedData.published : releasesList[releaseIndex].published,
            releaseDate: cleanedData.releaseDate || releasesList[releaseIndex].releaseDate,
            updatedAt: cleanedData.updatedAt
          };

          await updateDocument('system', 'releases-master', {
            releases: releasesList,
            lastUpdated: new Date().toISOString()
          }, authToken);

          log.info('[update-release] Updated master list');
        }
      }
    } catch (error) {
      log.error('[update-release] Warning: Could not update master list:', error);
      // Don't fail the whole operation if master list update fails
    }

    log.info('[update-release] Success - Update complete');

    return new Response(JSON.stringify({
      success: true,
      message: 'Release updated successfully',
      id: id
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[update-release] Critical error:', error.message);
    console.error('[update-release] Stack:', error.stack);

    return new Response(JSON.stringify({
      error: 'Internal server error',
      message: error.message,
      stack: error.stack
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}