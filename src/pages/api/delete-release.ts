// src/pages/api/delete-release.ts
// Deletes a release from Firebase (releases collection + master list)
import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
  warn: (...args: any[]) => isDev && console.warn(...args),
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

export const POST: APIRoute = async ({ request }) => {
  try {
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
    const releaseRef = db.collection('releases').doc(releaseId);
    const releaseDoc = await releaseRef.get();
    
    if (!releaseDoc.exists) {
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Release not found',
        releaseId: releaseId
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const releaseData = releaseDoc.data();

    // Delete the release document
    await releaseRef.delete();

    // Delete associated tracks
    try {
      const tracksQuery = await db.collection('tracks')
        .where('releaseId', '==', releaseId)
        .get();
      
      if (!tracksQuery.empty) {
        const batch = db.batch();
        tracksQuery.docs.forEach(doc => {
          batch.delete(doc.ref);
        });
        await batch.commit();
        log.info(`[delete-release] Deleted ${tracksQuery.size} associated tracks`);
      }
    } catch (error) {
      log.warn('[delete-release] Could not delete tracks:', error);
    }

    // Remove from master list
    try {
      const masterListRef = db.collection('system').doc('releases-master');
      const masterListDoc = await masterListRef.get();
      
      if (masterListDoc.exists) {
        const masterData = masterListDoc.data();
        const releasesList = masterData?.releases || [];
        const updatedReleases = releasesList.filter((r: any) => r.id !== releaseId);
        
        await masterListRef.update({
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