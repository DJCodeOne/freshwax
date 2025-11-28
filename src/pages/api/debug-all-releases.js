// src/pages/api/debug-all-releases.js
// Shows ALL releases regardless of status

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export const prerender = false;

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

export async function GET() {
  try {
    const snapshot = await db.collection('releases').get();
    
    const allReleases = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      allReleases.push({
        id: doc.id,
        releaseName: data.releaseName,
        artistName: data.artistName,
        status: data.status,
        published: data.published,
        approved: data.approved,
        // Show all fields
        allFields: Object.keys(data)
      });
    });
    
    return new Response(JSON.stringify({ 
      success: true,
      totalCount: allReleases.length,
      releases: allReleases
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    return new Response(JSON.stringify({ 
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}