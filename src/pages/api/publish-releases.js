// src/pages/api/publish-releases.js
// Firebase-based publish system with production-ready logging
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export const prerender = false;

const isDev = import.meta.env.DEV;
const log = {
  info: (...args) => isDev && console.log(...args),
  error: (...args) => console.error(...args),
};

// Initialize Firebase Admin
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

export async function POST({ request }) {
  try {
    const body = await request.json();
    const { releaseIds } = body;
    
    // Validate input
    if (!releaseIds || !Array.isArray(releaseIds) || releaseIds.length === 0) {
      return new Response(JSON.stringify({ 
        error: 'releaseIds must be a non-empty array',
        received: body
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    log.info(`[publish-releases] Publishing ${releaseIds.length} releases`);

    let updatedCount = 0;
    const notFound = [];
    const alreadyPublished = [];
    const successfullyPublished = [];
    
    // Process each release ID
    for (const releaseId of releaseIds) {
      try {
        const releaseRef = db.collection('releases').doc(releaseId);
        const releaseDoc = await releaseRef.get();
        
        if (!releaseDoc.exists) {
          notFound.push(releaseId);
          continue;
        }
        
        const release = releaseDoc.data();
        
        if (release.published) {
          alreadyPublished.push(releaseId);
          continue;
        }
        
        // Update release to published
        await releaseRef.update({
          published: true,
          publishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        
        updatedCount++;
        successfullyPublished.push(releaseId);
        
      } catch (error) {
        log.error(`[publish-releases] Error processing ${releaseId}:`, error.message);
        notFound.push(releaseId);
      }
    }
    
    // Update master list in Firebase
    try {
      const masterListRef = db.collection('system').doc('releases-master');
      const masterListDoc = await masterListRef.get();
      
      if (masterListDoc.exists) {
        const masterData = masterListDoc.data();
        const releasesList = masterData.releases || [];
        
        releasesList.forEach(release => {
          if (successfullyPublished.includes(release.id)) {
            release.published = true;
            release.publishedAt = new Date().toISOString();
            release.updatedAt = new Date().toISOString();
          }
        });
        
        await masterListRef.update({
          releases: releasesList,
          lastUpdated: new Date().toISOString()
        });
      }
    } catch (error) {
      log.error('[publish-releases] Warning: Could not update master list:', error.message);
    }

    log.info(`[publish-releases] Done: ${updatedCount} published, ${alreadyPublished.length} already published, ${notFound.length} not found`);

    if (updatedCount === 0 && notFound.length > 0) {
      return new Response(JSON.stringify({ 
        error: 'No matching releases found to publish',
        requestedIds: releaseIds,
        notFound: notFound
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ 
      success: true,
      message: `Published ${updatedCount} release${updatedCount !== 1 ? 's' : ''}`,
      publishedCount: updatedCount,
      alreadyPublished: alreadyPublished.length,
      notFound: notFound.length,
      details: { successfullyPublished, alreadyPublished, notFound }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    log.error('[publish-releases] Critical error:', error.message);
    
    return new Response(JSON.stringify({ 
      error: 'Internal server error',
      message: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}