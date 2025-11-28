// src/pages/api/get-ratings-batch.ts
// OPTIMIZED: Batch fetch ratings for multiple releases in ONE API call
import type { APIRoute } from 'astro';
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

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { releaseIds } = body;
    
    if (!Array.isArray(releaseIds) || releaseIds.length === 0) {
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Invalid releaseIds array' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    console.log(`[GET-RATINGS-BATCH] Fetching ratings for ${releaseIds.length} releases`);
    
    // Batch fetch all ratings in ONE query
    const ratingsData: Record<string, { average: number; count: number }> = {};
    
    // Fetch ratings for all releases in a single batch
    const ratingsPromises = releaseIds.map(async (releaseId) => {
      try {
        const doc = await db.collection('releases').doc(releaseId).get();
        
        if (doc.exists) {
          const data = doc.data();
          const ratings = data?.ratings || data?.overallRating || { average: 0, count: 0 };
          
          return {
            releaseId,
            average: ratings.average || 0,
            count: ratings.count || 0
          };
        }
        
        return {
          releaseId,
          average: 0,
          count: 0
        };
      } catch (error) {
        console.error(`[GET-RATINGS-BATCH] Error fetching ${releaseId}:`, error);
        return {
          releaseId,
          average: 0,
          count: 0
        };
      }
    });
    
    const results = await Promise.all(ratingsPromises);
    
    // Convert to object keyed by releaseId
    results.forEach(result => {
      ratingsData[result.releaseId] = {
        average: result.average,
        count: result.count
      };
    });
    
    console.log(`[GET-RATINGS-BATCH] ✓ Returned ratings for ${Object.keys(ratingsData).length} releases`);
    
    return new Response(JSON.stringify({ 
      success: true,
      ratings: ratingsData
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300' // Cache for 5 minutes
      }
    });
    
  } catch (error) {
    console.error('[GET-RATINGS-BATCH] Error:', error);
    return new Response(JSON.stringify({ 
      success: false,
      error: 'Failed to fetch ratings',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};