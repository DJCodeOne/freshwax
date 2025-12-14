// src/pages/api/update-master-json.js
// FIXED: Sets status to 'pending' by default, admin must approve before going live
import { getDocument, updateDocument, setDocument, initFirebaseEnv } from '../../lib/firebase-rest.js';

// Conditional logging - only logs in development
const isDev = import.meta.env.DEV;
const log = {
  info: (...args) => isDev && console.log(...args),
  error: (...args) => console.error(...args),
};

export const prerender = false;

export async function POST({ request, locals }) {
  // Initialize Firebase env for write operations
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const { release } = await request.json();

    if (!release || !release.id) {
      return new Response(JSON.stringify({
        error: 'Missing release data or release ID'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    log.info(`[Master JSON] Updating release: ${release.id}`);

    // CRITICAL: Default to pending status unless explicitly set
    // Admin must manually approve and publish from the admin panel
    const releaseData = {
      ...release,
      updatedAt: new Date().toISOString(),
      createdAt: release.createdAt || new Date().toISOString(),
      status: release.status || 'pending', // Default to pending
      published: release.published === true ? true : false, // Explicitly false unless set to true
      approved: release.approved === true ? true : false, // Default to not approved
      storage: 'r2' // Mark that this release uses R2 storage
    };

    log.info(`[Master JSON] Status: ${releaseData.status}, Published: ${releaseData.published}, Approved: ${releaseData.approved}`);

    // Set the document (will create or update)
    await setDocument('releases', release.id, releaseData);

    log.info(`[Master JSON] ✓ Release stored in Firestore [STATUS: ${releaseData.status}]`);

    // Also maintain a master list document for quick access
    const masterListDoc = await getDocument('system', 'releases-master');

    let releasesList = [];
    if (masterListDoc) {
      releasesList = masterListDoc.releases || [];
    }

    // Check if release already exists in master list
    const existingIndex = releasesList.findIndex(r => r.id === release.id);

    // Create summary for master list
    const releaseSummary = {
      id: release.id,
      title: release.title,
      artist: release.artist,
      coverUrl: release.coverUrl,
      published: releaseData.published,
      approved: releaseData.approved,
      status: releaseData.status,
      releaseDate: release.releaseDate,
      updatedAt: releaseData.updatedAt,
      storage: 'r2'
    };

    if (existingIndex >= 0) {
      // Update existing entry
      releasesList[existingIndex] = releaseSummary;
      log.info(`[Master JSON] Updated existing release in master list`);
    } else {
      // Add new entry
      releasesList.push(releaseSummary);
      log.info(`[Master JSON] Added new release to master list`);
    }

    // Update master list
    await setDocument('system', 'releases-master', {
      releases: releasesList,
      totalReleases: releasesList.length,
      lastUpdated: new Date().toISOString()
    });

    log.info(`[Master JSON] ✓ Master list updated (${releasesList.length} total releases)`);

    return new Response(JSON.stringify({
      success: true,
      releaseId: release.id,
      status: releaseData.status,
      published: releaseData.published,
      approved: releaseData.approved,
      totalReleases: releasesList.length,
      message: 'Release added to Firebase - PENDING APPROVAL'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[Master JSON] ✗ Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      details: error.stack
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// GET endpoint to retrieve all releases
export async function GET() {
  try {
    const masterListDoc = await getDocument('system', 'releases-master');

    if (!masterListDoc) {
      return new Response(JSON.stringify({
        releases: [],
        totalReleases: 0
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      releases: masterListDoc.releases || [],
      totalReleases: masterListDoc.totalReleases || 0,
      lastUpdated: masterListDoc.lastUpdated
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[Master JSON] ✗ GET Error:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
