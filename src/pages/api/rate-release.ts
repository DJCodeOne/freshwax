// src/pages/api/rate-release.ts
// UPDATED: Uses Firebase as source of truth

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

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

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { releaseId, rating, userId } = body;

    console.log('[rate-release] Full request body:', body);
    console.log('[rate-release] Received:', { releaseId, rating, userId });

    // Validate rating first
    if (!releaseId || !rating || rating < 1 || rating > 5) {
      console.log('[rate-release] Invalid rating:', { releaseId, rating });
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Invalid rating (must be 1-5)' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check userId after other validations
    if (!userId) {
      console.log('[rate-release] No userId provided');
      return new Response(JSON.stringify({ 
        success: false,
        error: 'You must be logged in to rate releases' 
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get release from Firebase
    const releaseRef = db.collection('releases').doc(releaseId);
    const releaseDoc = await releaseRef.get();
    
    if (!releaseDoc.exists) {
      console.log('[rate-release] Release not found:', releaseId);
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Release not found' 
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const releaseData = releaseDoc.data();

    // Initialize ratings structure if needed
    if (!releaseData.ratings) {
      releaseData.ratings = {
        average: 0,
        count: 0,
        fiveStarCount: 0,
        userRatings: {}
      };
    }

    const existingRating = releaseData.ratings.userRatings?.[userId];
    
    if (existingRating) {
      // Update existing rating
      console.log('[rate-release] Updating existing rating for user:', userId);
      
      const currentAverage = releaseData.ratings.average || 0;
      const ratingsCount = releaseData.ratings.count || 0;
      const fiveStarCount = releaseData.ratings.fiveStarCount || 0;
      
      // Remove old rating from total
      const totalRating = (currentAverage * ratingsCount) - existingRating;
      
      // Add new rating
      const newAverageRating = (totalRating + rating) / ratingsCount;
      const newFiveStarCount = fiveStarCount - (existingRating === 5 ? 1 : 0) + (rating === 5 ? 1 : 0);
      
      releaseData.ratings.average = parseFloat(newAverageRating.toFixed(2));
      releaseData.ratings.fiveStarCount = newFiveStarCount;
      releaseData.ratings.userRatings[userId] = rating;
      
    } else {
      // New rating
      console.log('[rate-release] Adding new rating for user:', userId);
      
      const currentAverage = releaseData.ratings.average || 0;
      const ratingsCount = releaseData.ratings.count || 0;
      const fiveStarCount = releaseData.ratings.fiveStarCount || 0;
      
      const totalRating = currentAverage * ratingsCount;
      const newRatingsCount = ratingsCount + 1;
      const newAverageRating = (totalRating + rating) / newRatingsCount;
      const newFiveStarCount = rating === 5 ? fiveStarCount + 1 : fiveStarCount;
      
      releaseData.ratings.average = parseFloat(newAverageRating.toFixed(2));
      releaseData.ratings.count = newRatingsCount;
      releaseData.ratings.fiveStarCount = newFiveStarCount;
      
      if (!releaseData.ratings.userRatings) {
        releaseData.ratings.userRatings = {};
      }
      releaseData.ratings.userRatings[userId] = rating;
    }

    releaseData.ratings.lastRatedAt = new Date().toISOString();
    releaseData.updatedAt = new Date().toISOString();

    console.log('[rate-release] Updated rating:', {
      average: releaseData.ratings.average,
      count: releaseData.ratings.count,
      fiveStarCount: releaseData.ratings.fiveStarCount
    });

    // Save to Firebase
    await releaseRef.update({
      ratings: releaseData.ratings,
      updatedAt: releaseData.updatedAt
    });

    console.log('[rate-release] ✓ Saved to Firebase');

    return new Response(JSON.stringify({
      success: true,
      newRating: releaseData.ratings.average,
      ratingsCount: releaseData.ratings.count,
      fiveStarCount: releaseData.ratings.fiveStarCount
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[rate-release] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to save rating',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};