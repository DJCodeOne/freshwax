// src/pages/api/delete-release.ts
// Deletes a release from Firebase (releases collection + master list)
import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

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
  console.log('\n========================================');
  console.log('[DELETE-RELEASE] POST REQUEST RECEIVED');
  console.log('========================================\n');
  
  try {
    const body = await request.json();
    console.log('[DELETE-RELEASE] Request body:', JSON.stringify(body, null, 2));
    
    const { releaseId } = body;
    
    if (!releaseId) {
      console.error('[DELETE-RELEASE] ERROR: No releaseId provided');
      return new Response(JSON.stringify({ 
        success: false,
        error: 'releaseId is required' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log(`[DELETE-RELEASE] Deleting release: ${releaseId}`);

    // Get release from Firestore to verify it exists
    const releaseRef = db.collection('releases').doc(releaseId);
    const releaseDoc = await releaseRef.get();
    
    if (!releaseDoc.exists) {
      console.error('[DELETE-RELEASE] ERROR: Release not found');
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
    console.log(`[DELETE-RELEASE] Found release: "${releaseData?.releaseName}" by ${releaseData?.artistName}`);

    // Delete the release document
    await releaseRef.delete();
    console.log('[DELETE-RELEASE] ✓ Deleted from releases collection');

    // Also delete associated track documents if they exist
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
        console.log(`[DELETE-RELEASE] ✓ Deleted ${tracksQuery.size} associated tracks`);
      }
    } catch (error) {
      console.warn('[DELETE-RELEASE] Warning: Could not delete tracks:', error);
      // Don't fail the whole operation if track deletion fails
    }

    // Remove from master list
    try {
      const masterListRef = db.collection('system').doc('releases-master');
      const masterListDoc = await masterListRef.get();
      
      if (masterListDoc.exists) {
        const masterData = masterListDoc.data();
        const releasesList = masterData?.releases || [];
        
        // Filter out the deleted release
        const updatedReleases = releasesList.filter((r: any) => r.id !== releaseId);
        
        await masterListRef.update({
          releases: updatedReleases,
          totalReleases: updatedReleases.length,
          lastUpdated: new Date().toISOString()
        });
        
        console.log('[DELETE-RELEASE] ✓ Removed from master list');
      }
    } catch (error) {
      console.error('[DELETE-RELEASE] Warning: Could not update master list:', error);
      // Don't fail the whole operation if master list update fails
    }

    console.log('[DELETE-RELEASE] ✓ SUCCESS - Delete complete!');
    console.log('========================================\n');

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
    console.error('\n========================================');
    console.error('[DELETE-RELEASE] CRITICAL ERROR');
    console.error('========================================');
    console.error('[DELETE-RELEASE] Error message:', error instanceof Error ? error.message : 'Unknown error');
    console.error('[DELETE-RELEASE] Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    console.error('========================================\n');
    
    return new Response(JSON.stringify({ 
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};