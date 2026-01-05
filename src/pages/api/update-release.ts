// src/pages/api/update-release.ts
// Firebase-based release update API - uses service account for writes
import { getDocument, initFirebaseEnv } from '../../lib/firebase-rest';
import { saUpdateDocument } from '../../lib/firebase-service-account';
import { requireAdminAuth } from '../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { d1UpsertRelease } from '../../lib/d1-catalog';

export const prerender = false;

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
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

export async function POST({ request, locals }: any) {
  // Admin authentication required
  const authError = requireAdminAuth(request, locals);
  if (authError) return authError;

  // Rate limit: write operations - 30 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`update-release:${clientId}`, RateLimiters.write);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  log.info('[update-release] POST request received');

  try {
    const env = locals?.runtime?.env || {};

    // Initialize Firebase environment for reads
    initFirebaseEnv({
      FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
      FIREBASE_API_KEY: env.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
    });

    const updates = await request.json();
    log.info('[update-release] Request body:', JSON.stringify(updates, null, 2));

    const { id, idToken, ...updateData } = updates;

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

    // Sync pricing object when price fields are updated
    if (cleanedData.pricePerSale !== undefined || cleanedData.trackPrice !== undefined) {
      const existingPricing = releaseDoc.pricing || {};
      cleanedData.pricing = {
        ...existingPricing,
        digital: cleanedData.pricePerSale ?? existingPricing.digital ?? 0,
        track: cleanedData.trackPrice ?? existingPricing.track ?? 0
      };
    }

    // Handle per-track BPM and Key updates
    if (cleanedData.trackUpdates && Array.isArray(cleanedData.trackUpdates)) {
      const existingTracks = releaseDoc.tracks || [];
      const updatedTracks = existingTracks.map((track: any, idx: number) => {
        const trackUpdate = cleanedData.trackUpdates.find((t: any) => t.index === idx);
        if (trackUpdate) {
          return {
            ...track,
            bpm: trackUpdate.bpm ?? track.bpm,
            key: trackUpdate.key ?? track.key
          };
        }
        return track;
      });
      cleanedData.tracks = updatedTracks;
      delete cleanedData.trackUpdates; // Remove trackUpdates from the data to save
    }

    log.info('[update-release] Cleaned data:', JSON.stringify(cleanedData, null, 2));

    // Get service account key for writes
    const serviceAccountKey = getServiceAccountKey(env);
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      log.error('[update-release] Service account not configured');
      return new Response(JSON.stringify({
        error: 'Service account not configured'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Update in Firestore using service account auth
    await saUpdateDocument(serviceAccountKey, projectId, 'releases', id, cleanedData);
    log.info('[update-release] Updated in Firestore');

    // Dual-write to D1 (secondary, non-blocking)
    const db = env?.DB;
    if (db) {
      try {
        // Get the full updated document for D1
        const updatedDoc = await getDocument('releases', id);
        if (updatedDoc) {
          await d1UpsertRelease(db, id, updatedDoc);
          log.info('[update-release] Also updated in D1');
        }
      } catch (d1Error) {
        // Log D1 error but don't fail the request
        log.error('[update-release] D1 dual-write failed (non-critical):', d1Error);
      }
    }

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

          await saUpdateDocument(serviceAccountKey, projectId, 'system', 'releases-master', {
            releases: releasesList,
            lastUpdated: new Date().toISOString()
          });

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