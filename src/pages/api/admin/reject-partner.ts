// /src/pages/api/admin/reject-partner.ts
// API endpoint to reject (delete) a partner application

import type { APIRoute } from 'astro';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
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
    const { partnerId } = await request.json();
    
    if (!partnerId) {
      return new Response(JSON.stringify({ error: 'Partner ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Delete partner document
    await db.collection('artists').doc(partnerId).delete();
    
    // TODO: Optionally send rejection email
    // Be mindful of how you communicate rejections
    
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Error rejecting partner:', error);
    return new Response(JSON.stringify({ error: 'Failed to reject partner' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};