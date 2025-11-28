// src/pages/api/get-release.ts
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

export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    const adminMode = url.searchParams.get('admin') === 'true';

    console.log('[GET-RELEASE] Fetching release:', id, 'Admin mode:', adminMode);

    if (!id) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Release ID is required' 
        }),
        { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    const releaseDoc = await db.collection('releases').doc(id).get();

    if (!releaseDoc.exists) {
      console.log('[GET-RELEASE] Release not found:', id);
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Release not found' 
        }),
        { 
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    const data = releaseDoc.data();
    
    // Skip status check in admin mode OR if status is live/published
    const isAccessible = adminMode || data?.status === 'live' || data?.published === true;
    
    if (!isAccessible) {
      console.log('[GET-RELEASE] Release not published:', id);
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Release not available' 
        }),
        { 
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    const release = {
      id: releaseDoc.id,
      ...data,
      ratingsAverage: data?.ratings?.average || data?.ratingsAverage || 0,
      ratingsCount: data?.ratings?.count || data?.ratingsCount || 0,
      fiveStarCount: data?.ratings?.fiveStarCount || data?.fiveStarCount || 0,
      overallRating: {
        average: data?.overallRating?.average || data?.ratings?.average || 0,
        count: data?.overallRating?.count || data?.ratings?.count || 0,
        total: data?.overallRating?.total || data?.ratings?.total || 0
      },
      comments: data?.comments || [],
      notes: data?.metadata?.notes || data?.notes || data?.releaseDescription || '',
      releaseDate: data?.metadata?.officialReleaseDate || data?.releaseDate || new Date().toISOString(),
      pricePerSale: data?.pricePerSale || data?.pricing?.digital || 0,
      trackPrice: data?.trackPrice || data?.pricing?.track || 1.00,
      vinylPrice: data?.vinylPrice || data?.pricing?.vinyl || 0,
      coverArtUrl: data?.coverArtUrl || data?.artworkUrl || data?.artwork?.cover || null,
      additionalArtwork: data?.additionalArtwork || data?.artwork?.additional || [],
    };

    console.log('[GET-RELEASE] Success:', release.releaseName, 'by', release.artistName);

    return new Response(
      JSON.stringify({ 
        success: true, 
        release: release
      }),
      { 
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        }
      }
    );

  } catch (error) {
    console.error('[GET-RELEASE] Error:', error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: 'Failed to fetch release',
        details: error instanceof Error ? error.message : 'Unknown error'
      }),
      { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
};

