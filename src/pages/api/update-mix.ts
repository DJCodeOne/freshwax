// src/pages/api/update-mix.ts
// API endpoint to update mix description and backfill userId

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
    const { mixId, description, tracklist, userId } = await request.json();
    
    if (!mixId) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Missing mixId' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Verify the user owns this mix
    const partnerId = cookies.get('partnerId')?.value || '';
    const customerId = cookies.get('customerId')?.value || '';
    const currentUserId = partnerId || customerId;
    
    if (!currentUserId) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Not authenticated' 
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Get the mix
    const mixRef = db.collection('dj-mixes').doc(mixId);
    const mixDoc = await mixRef.get();
    
    if (!mixDoc.exists) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Mix not found' 
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const mixData = mixDoc.data();
    
    // Check ownership (by userId or djName match - case insensitive)
    const partnerDoc = await db.collection('artists').doc(currentUserId).get();
    const partnerName = partnerDoc.exists ? partnerDoc.data()?.artistName?.toLowerCase().trim() : null;
    
    const mixDjName = (mixData?.djName || mixData?.dj_name || '').toLowerCase().trim();
    
    const isOwner = 
      mixData?.userId === currentUserId ||
      (partnerName && mixDjName === partnerName);
    
    if (!isOwner) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Not authorized to edit this mix' 
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Build update object
    const updateData: Record<string, any> = {
      updatedAt: new Date().toISOString()
    };
    
    if (description !== undefined) {
      updateData.description = description.slice(0, 150);
      updateData.shoutOuts = description.slice(0, 150);
    }
    
    // Handle tracklist update - strip leading track numbers for consistent display
    if (tracklist !== undefined) {
      const tracklistRaw = tracklist.slice(0, 1500);
      const tracklistArray = tracklistRaw.split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0)
        .map((line: string) => {
          // Remove leading track numbers in formats like: "1.", "01.", "1)", "1:", "1 -", etc.
          return line.replace(/^\d+[\.\)\:\-]?\s*[-–—]?\s*/, '').trim();
        })
        .filter((line: string) => line.length > 0);
      
      updateData.tracklist = tracklistRaw;
      updateData.tracklistArray = tracklistArray;
      updateData.trackCount = tracklistArray.length;
    }
    
    // Backfill userId if missing
    if (!mixData?.userId && currentUserId) {
      updateData.userId = currentUserId;
    }
    
    await mixRef.update(updateData);
    
    return new Response(JSON.stringify({ 
      success: true,
      message: 'Mix updated successfully'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Error updating mix:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Failed to update mix' 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
