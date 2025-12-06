// src/pages/api/update-partner.ts
// API endpoint to update partner/artist profile and settings

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Initialize Firebase Admin
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

const db = getFirestore();

export const POST: APIRoute = async ({ request, cookies }) => {
  try {
    const data = await request.json();
    const { id, ...updateFields } = data;
    
    // Verify the user is updating their own profile
    const partnerId = cookies.get('partnerId')?.value || '';
    
    if (!partnerId) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Not authenticated' 
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (id !== partnerId) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Not authorized' 
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Get partner document
    const partnerRef = db.collection('artists').doc(partnerId);
    const partnerDoc = await partnerRef.get();
    
    if (!partnerDoc.exists) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Partner not found' 
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Build clean update object (only allowed fields)
    const allowedFields = [
      'artistName', 'bio',
      'avatarUrl', 'bannerUrl', 'location', 'genres'
    ];
    
    const cleanData: Record<string, any> = {
      updatedAt: new Date().toISOString()
    };
    
    for (const field of allowedFields) {
      if (updateFields[field] !== undefined) {
        cleanData[field] = updateFields[field];
      }
    }
    
    // Validate specific fields
    if (cleanData.bio && cleanData.bio.length > 200) {
      cleanData.bio = cleanData.bio.slice(0, 200);
    }
    
    if (cleanData.artistName && cleanData.artistName.length > 50) {
      cleanData.artistName = cleanData.artistName.slice(0, 50);
    }
    
    await partnerRef.update(cleanData);
    
    return new Response(JSON.stringify({ 
      success: true,
      message: 'Profile updated successfully'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Error updating partner:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Failed to update profile' 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
