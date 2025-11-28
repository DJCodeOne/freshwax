// src/pages/api/update-release.js
// Firebase-based release update API
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
  console.log('[UPDATE-RELEASE] POST REQUEST RECEIVED');
  console.log('========================================\n');
  
  try {
    const updates = await request.json();
    console.log('[UPDATE-RELEASE] Request body:', JSON.stringify(updates, null, 2));
    
    const { id, ...updateData } = updates;
    
    if (!id) {
      console.error('[UPDATE-RELEASE] ERROR: No release ID provided');
      return new Response(JSON.stringify({ 
        error: 'Release ID is required' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log(`[UPDATE-RELEASE] Updating release: ${id}`);

    // Get release from Firestore
    const releaseRef = db.collection('releases').doc(id);
    const releaseDoc = await releaseRef.get();
    
    if (!releaseDoc.exists) {
      console.error('[UPDATE-RELEASE] ERROR: Release not found');
      return new Response(JSON.stringify({ 
        error: 'Release not found',
        id: id
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Clean up undefined values (Firestore doesn't like them)
    const cleanedData = {};
    for (const [key, value] of Object.entries(updateData)) {
      if (value !== undefined) {
        cleanedData[key] = value;
      }
    }

    // Add updatedAt timestamp
    cleanedData.updatedAt = new Date().toISOString();

    console.log('[UPDATE-RELEASE] Cleaned data:', JSON.stringify(cleanedData, null, 2));

    // Update in Firestore
    await releaseRef.update(cleanedData);
    console.log('[UPDATE-RELEASE] ✓ Updated in Firestore');

    // Also update the master list
    try {
      const masterListRef = db.collection('system').doc('releases-master');
      const masterListDoc = await masterListRef.get();
      
      if (masterListDoc.exists) {
        const masterData = masterListDoc.data();
        const releasesList = masterData.releases || [];
        
        // Find and update the release in master list
        const releaseIndex = releasesList.findIndex(r => r.id === id);
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
          
          await masterListRef.update({
            releases: releasesList,
            lastUpdated: new Date().toISOString()
          });
          
          console.log('[UPDATE-RELEASE] ✓ Updated master list');
        }
      }
    } catch (error) {
      console.error('[UPDATE-RELEASE] Warning: Could not update master list:', error);
      // Don't fail the whole operation if master list update fails
    }

    console.log('[UPDATE-RELEASE] ✓ SUCCESS - Update complete!');
    console.log('========================================\n');

    return new Response(JSON.stringify({ 
      success: true,
      message: 'Release updated successfully',
      id: id
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('\n========================================');
    console.error('[UPDATE-RELEASE] CRITICAL ERROR');
    console.error('========================================');
    console.error('[UPDATE-RELEASE] Error message:', error.message);
    console.error('[UPDATE-RELEASE] Error stack:', error.stack);
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