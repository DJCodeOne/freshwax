// src/pages/api/publish-releases.js
// UPDATED: Firebase-based publish system
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export const prerender = false;

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
  console.log('\n========================================');
  console.log('[PUBLISH-RELEASES] POST REQUEST RECEIVED');
  console.log('========================================\n');
  
  try {
    // Parse request body
    const body = await request.json();
    console.log('[PUBLISH-RELEASES] Request body:', JSON.stringify(body, null, 2));
    
    const { releaseIds } = body;
    
    // Validate input
    if (!releaseIds) {
      console.error('[PUBLISH-RELEASES] ERROR: No releaseIds provided');
      return new Response(JSON.stringify({ 
        error: 'No release IDs provided',
        received: body
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (!Array.isArray(releaseIds)) {
      console.error('[PUBLISH-RELEASES] ERROR: releaseIds is not an array:', typeof releaseIds);
      return new Response(JSON.stringify({ 
        error: 'releaseIds must be an array',
        received: releaseIds,
        type: typeof releaseIds
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (releaseIds.length === 0) {
      console.error('[PUBLISH-RELEASES] ERROR: releaseIds array is empty');
      return new Response(JSON.stringify({ 
        error: 'releaseIds array is empty' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log(`[PUBLISH-RELEASES] Publishing ${releaseIds.length} releases:`, releaseIds);

    let updatedCount = 0;
    const notFound = [];
    const alreadyPublished = [];
    const successfullyPublished = [];
    
    // Process each release ID
    for (const releaseId of releaseIds) {
      console.log(`[PUBLISH-RELEASES] Processing release ID: "${releaseId}"`);
      
      try {
        // Get release from Firestore
        const releaseRef = db.collection('releases').doc(releaseId);
        const releaseDoc = await releaseRef.get();
        
        if (!releaseDoc.exists) {
          console.log(`[PUBLISH-RELEASES]   ✗ Release not found in Firebase`);
          notFound.push(releaseId);
          continue;
        }
        
        const release = releaseDoc.data();
        console.log(`[PUBLISH-RELEASES]   ✓ Found release: "${release.title}" by ${release.artist}`);
        
        if (release.published) {
          console.log(`[PUBLISH-RELEASES]   ⚠ Already published (skipping)`);
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
        console.log(`[PUBLISH-RELEASES]   ✓ Marked as published in Firebase`);
        
      } catch (error) {
        console.error(`[PUBLISH-RELEASES]   ✗ Error processing release ${releaseId}:`, error);
        notFound.push(releaseId);
      }
    }
    
    // Also update the master list in Firebase
    try {
      const masterListRef = db.collection('system').doc('releases-master');
      const masterListDoc = await masterListRef.get();
      
      if (masterListDoc.exists) {
        const masterData = masterListDoc.data();
        const releasesList = masterData.releases || [];
        
        // Update published status in master list
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
        
        console.log('[PUBLISH-RELEASES] ✓ Updated master list in Firebase');
      }
    } catch (error) {
      console.error('[PUBLISH-RELEASES] Warning: Could not update master list:', error);
      // Don't fail the whole operation if master list update fails
    }

    console.log('\n[PUBLISH-RELEASES] Summary:');
    console.log(`  - Successfully published: ${updatedCount}`);
    console.log(`  - Already published: ${alreadyPublished.length}`);
    console.log(`  - Not found: ${notFound.length}`);

    if (updatedCount === 0 && notFound.length > 0) {
      console.error('[PUBLISH-RELEASES] ERROR: No matching releases found');
      
      return new Response(JSON.stringify({ 
        error: 'No matching releases found to publish',
        requestedIds: releaseIds,
        notFound: notFound,
        suggestion: 'Check that the release IDs match exactly (case-sensitive)'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (updatedCount === 0 && alreadyPublished.length > 0) {
      console.log('[PUBLISH-RELEASES] All selected releases were already published');
      return new Response(JSON.stringify({ 
        success: true,
        message: 'All selected releases were already published',
        alreadyPublished: alreadyPublished.length
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log('[PUBLISH-RELEASES] ✓ SUCCESS - Publish complete!');
    console.log('========================================\n');

    return new Response(JSON.stringify({ 
      success: true,
      message: `Published ${updatedCount} release${updatedCount > 1 ? 's' : ''}`,
      publishedCount: updatedCount,
      alreadyPublished: alreadyPublished.length,
      notFound: notFound.length,
      details: {
        successfullyPublished,
        alreadyPublished,
        notFound
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('\n========================================');
    console.error('[PUBLISH-RELEASES] CRITICAL ERROR');
    console.error('========================================');
    console.error('[PUBLISH-RELEASES] Error message:', error.message);
    console.error('[PUBLISH-RELEASES] Error stack:', error.stack);
    console.error('========================================\n');
    
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