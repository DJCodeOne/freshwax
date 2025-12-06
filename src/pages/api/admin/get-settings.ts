// src/pages/api/admin/get-settings.ts
// Get admin settings

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

export const GET: APIRoute = async () => {
  try {
    const settingsDoc = await db.collection('settings').doc('admin').get();
    
    if (!settingsDoc.exists) {
      // Return default settings
      return new Response(JSON.stringify({
        success: true,
        settings: {
          showMixCharts: false
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      settings: settingsDoc.data()
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[get-settings] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to get settings'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
