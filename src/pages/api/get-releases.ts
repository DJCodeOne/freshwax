// src/pages/api/get-releases.ts
// OPTIMIZED: Add limit parameter to reduce API calls, removed .orderBy() to avoid composite index requirement
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
  const url = new URL(request.url);
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? parseInt(limitParam) : 100; // Default max 100
  
  console.log(`[GET-RELEASES] Fetching up to ${limit} releases from Firebase...`);
  
  try {
    // OPTIMIZED: Removed .orderBy() to avoid Firestore composite index requirement
    // We'll sort in-memory instead
    const query = db.collection('releases')
      .where('status', '==', 'live');
    
    const releasesSnapshot = await query.get();
    
    const allReleases: any[] = [];
    releasesSnapshot.forEach(doc => {
      const data = doc.data();
      
      const release = {
        id: doc.id,
        ...data,
        ratingsAverage: data.ratings?.average || 0,
        ratingsCount: data.ratings?.count || 0,
        fiveStarCount: data.ratings?.fiveStarCount || 0,
        comments: data.comments || [],
        metadata: {
          notes: data.metadata?.notes || '',
          officialReleaseDate: data.metadata?.officialReleaseDate || null
        }
      };
      
      allReleases.push(release);
    });
    
    // Sort by releaseDate in-memory (newest first)
    allReleases.sort((a, b) => {
      const dateA = new Date(a.releaseDate || 0).getTime();
      const dateB = new Date(b.releaseDate || 0).getTime();
      return dateB - dateA;
    });
    
    // Apply limit after sorting
    const limitedReleases = limit > 0 ? allReleases.slice(0, limit) : allReleases;
    
    console.log(`[GET-RELEASES] ✓ Loaded ${allReleases.length} releases, returning ${limitedReleases.length} (limit: ${limit})`);
    
    return new Response(JSON.stringify({ 
      success: true,
      releases: limitedReleases,
      totalReleases: limitedReleases.length,
      source: 'firebase',
      limited: limit > 0
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300' // Cache for 5 minutes
      }
    });
    
  } catch (error) {
    console.error('[GET-RELEASES] Error:', error);
    return new Response(JSON.stringify({ 
      success: false,
      error: 'Failed to fetch releases',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};