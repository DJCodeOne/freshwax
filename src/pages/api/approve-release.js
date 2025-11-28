// src/pages/api/approve-release.js
// Approves or rejects pending releases in Firebase
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
  console.log('[APPROVE-RELEASE] POST REQUEST RECEIVED');
  console.log('========================================\n');
  
  try {
    const body = await request.json();
    console.log('[APPROVE-RELEASE] Request body:', JSON.stringify(body, null, 2));
    
    const { releaseId, action } = body;
    
    // Validate input
    if (!releaseId || !action) {
      console.error('[APPROVE-RELEASE] ERROR: Missing releaseId or action');
      return new Response(JSON.stringify({ 
        success: false,
        error: 'releaseId and action are required' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!['approve', 'reject'].includes(action)) {
      console.error('[APPROVE-RELEASE] ERROR: Invalid action');
      return new Response(JSON.stringify({ 
        success: false,
        error: 'action must be "approve" or "reject"' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log(`[APPROVE-RELEASE] Processing: ${action} release ${releaseId}`);

    // Get release from Firestore
    const releaseRef = db.collection('releases').doc(releaseId);
    const releaseDoc = await releaseRef.get();
    
    if (!releaseDoc.exists) {
      console.error('[APPROVE-RELEASE] ERROR: Release not found');
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
    console.log(`[APPROVE-RELEASE] Found release: "${releaseData.releaseName}" by ${releaseData.artistName}`);

    // Update release status
    const updateData = {
      status: action === 'approve' ? 'live' : 'rejected',
      published: action === 'approve',
      approvedAt: action === 'approve' ? new Date().toISOString() : null,
      rejectedAt: action === 'reject' ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString()
    };

    await releaseRef.update(updateData);
    console.log(`[APPROVE-RELEASE] ✓ Release ${action}d successfully`);

    // Update master list
    try {
      const masterListRef = db.collection('system').doc('releases-master');
      const masterListDoc = await masterListRef.get();
      
      if (masterListDoc.exists) {
        const masterData = masterListDoc.data();
        const releasesList = masterData.releases || [];
        
        // Find and update the release in master list
        const releaseIndex = releasesList.findIndex(r => r.id === releaseId);
        if (releaseIndex >= 0) {
          releasesList[releaseIndex] = {
            ...releasesList[releaseIndex],
            status: updateData.status,
            published: updateData.published,
            updatedAt: updateData.updatedAt
          };
          
          await masterListRef.update({
            releases: releasesList,
            lastUpdated: new Date().toISOString()
          });
          
          console.log('[APPROVE-RELEASE] ✓ Updated master list');
        }
      }
    } catch (error) {
      console.error('[APPROVE-RELEASE] Warning: Could not update master list:', error);
      // Don't fail the whole operation if master list update fails
    }

    console.log('[APPROVE-RELEASE] ✓ SUCCESS - Approval process complete!');
    console.log('========================================\n');

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
    console.error('\n========================================');
    console.error('[APPROVE-RELEASE] CRITICAL ERROR');
    console.error('========================================');
    console.error('[APPROVE-RELEASE] Error message:', error.message);
    console.error('[APPROVE-RELEASE] Error stack:', error.stack);
    console.error('========================================\n');
    
    return new Response(JSON.stringify({ 
      success: false,
      error: 'Internal server error',
      message: error.message,
      stack: error.stack
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}