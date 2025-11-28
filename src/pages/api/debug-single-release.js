// src/pages/api/debug-single-release.js
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

export async function GET({ url }) {
  try {
    const id = url.searchParams.get('id');
    
    if (!id) {
      // Get first release
      const snapshot = await db.collection('releases').limit(1).get();
      if (snapshot.empty) {
        return new Response(JSON.stringify({ success: false, error: 'No releases found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const doc = snapshot.docs[0];
      const data = doc.data();
      
      return new Response(JSON.stringify({
        success: true,
        id: doc.id,
        rawData: data,
        trackCount: data.tracks?.length || 0,
        tracks: data.tracks?.map((t, i) => ({
          index: i,
          trackNumber: t.trackNumber,
          displayTrackNumber: t.displayTrackNumber,
          trackName: t.trackName,
          previewUrl: t.previewUrl,
          hasPreview: !!t.previewUrl
        }))
      }, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const doc = await db.collection('releases').doc(id).get();
    
    if (!doc.exists) {
      return new Response(JSON.stringify({ success: false, error: 'Release not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const data = doc.data();
    
    return new Response(JSON.stringify({
      success: true,
      id: doc.id,
      rawData: data,
      trackCount: data.tracks?.length || 0,
      tracks: data.tracks?.map((t, i) => ({
        index: i,
        trackNumber: t.trackNumber,
        displayTrackNumber: t.displayTrackNumber,
        trackName: t.trackName,
        previewUrl: t.previewUrl,
        hasPreview: !!t.previewUrl
      }))
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