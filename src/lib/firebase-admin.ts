// src/lib/firebase-admin.ts
// Shared Firebase Admin SDK initialization

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// Initialize Firebase Admin with error handling
try {
  if (!getApps().length) {
    const projectId = import.meta.env.FIREBASE_PROJECT_ID;
    const clientEmail = import.meta.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    
    if (!projectId || !clientEmail || !privateKey) {
      console.error('[firebase-admin] Missing required environment variables:', {
        hasProjectId: !!projectId,
        hasClientEmail: !!clientEmail,
        hasPrivateKey: !!privateKey
      });
    }
    
    initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });
  }
} catch (error) {
  console.error('[firebase-admin] Failed to initialize:', error);
}

// Export the Firestore instance
export const adminDb = getFirestore();

// Re-export FieldValue for convenience
export { FieldValue };
