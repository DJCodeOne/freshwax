// src/pages/api/approve-release.js
// Approves or rejects pending releases in Firebase
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

    // Update release status
    const updateData = {
      status: action === 'approve' ? 'live' : 'rejected',
      published: action === 'approve',
      approvedAt: action === 'approve' ? new Date().toISOString() : null,
      rejectedAt: action === 'reject' ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString()
    };

    await releaseRef.update(updateData);

    // Update master list
    try {
      const masterListRef = db.collection('system').doc('releases-master');
      const masterListDoc = await masterListRef.get();
      
      if (masterListDoc.exists) {
        const masterData = masterListDoc.data();
        const releasesList = masterData.releases || [];
        
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
        }
      }
    } catch (error) {
      log.error('[approve-release] Warning: Could not update master list:', error.message);
    }

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