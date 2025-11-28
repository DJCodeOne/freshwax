import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

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

export const GET = async () => {
  try {
    console.log('🔍 Checking Firebase releases collection...');
    
    const releasesSnapshot = await db.collection('releases').get();
    
    console.log('📊 Total documents:', releasesSnapshot.size);
    
    const releases = [];
    releasesSnapshot.forEach(doc => {
      const data = doc.data();
      releases.push({
        id: doc.id,
        ...data
      });
      console.log('📄 Document ID:', doc.id);
      console.log('📄 Document data:', JSON.stringify(data, null, 2));
    });

    return new Response(JSON.stringify({
      success: true,
      count: releases.length,
      releases: releases,
      collections: 'releases',
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('❌ Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      stack: error.stack,
    }, null, 2), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};