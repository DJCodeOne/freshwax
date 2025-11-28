// src/pages/api/get-ratings.ts
import type { APIRoute } from 'astro';
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

export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const releaseId = url.searchParams.get('releaseId');

    if (!releaseId) {
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Release ID required' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const releaseDoc = await db.collection('releases').doc(releaseId).get();
    
    if (!releaseDoc.exists) {
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Release not found' 
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const data = releaseDoc.data();
    const ratings = data?.ratings || { average: 0, count: 0, fiveStarCount: 0 };

    console.log(`[get-ratings] Release: ${releaseId}`, ratings);

    return new Response(JSON.stringify({
      success: true,
      average: ratings.average || 0,
      count: ratings.count || 0,
      fiveStarCount: ratings.fiveStarCount || 0
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[get-ratings] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch ratings'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};