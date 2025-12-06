// src/pages/api/admin/update-settings.ts
// Update admin settings

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
    const body = await request.json();
    
    // Get current settings
    const settingsRef = db.collection('settings').doc('admin');
    const currentDoc = await settingsRef.get();
    const currentSettings = currentDoc.exists ? currentDoc.data() : {};
    
    // Merge new settings
    const updatedSettings = {
      ...currentSettings,
      ...body,
      updatedAt: new Date()
    };
    
    await settingsRef.set(updatedSettings, { merge: true });

    return new Response(JSON.stringify({
      success: true,
      settings: updatedSettings
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[update-settings] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to update settings'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
