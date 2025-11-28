// src/pages/api/fix-release-status.js
// One-time script to set all releases to status: 'live'

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

export async function GET() {
  try {
    const snapshot = await db.collection('releases').get();
    
    const updates = [];
    
    for (const doc of snapshot.docs) {
      const data = doc.data();
      
      // Update if status is not 'live'
      if (data.status !== 'live') {
        await doc.ref.update({
          status: 'live',
          published: true,
          approved: true,
          updatedAt: new Date().toISOString()
        });
        
        updates.push({
          id: doc.id,
          oldStatus: data.status,
          newStatus: 'live'
        });
      }
    }
    
    return new Response(JSON.stringify({ 
      success: true,
      message: `Updated ${updates.length} releases to status: 'live'`,
      updates: updates
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