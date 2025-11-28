// src/firebase/server.ts
import { initializeApp, cert, getApps, type ServiceAccount } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

let db: Firestore | null = null;

// Initialize Firebase Admin
try {
  if (!getApps().length) {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;
    
    const serviceAccount: ServiceAccount = {
      projectId: "freshwax-store",
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey?.replace(/\\n/g, '\n'),
    };

    initializeApp({
      credential: cert(serviceAccount),
    });
  }
  db = getFirestore();
} catch (error) {
  console.error('[Firebase] Failed to initialize:', error);
  db = null;
}

export { db };