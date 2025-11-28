// src/firebase/server.ts
import { initializeApp, cert, getApps, type ServiceAccount } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Initialize Firebase Admin
if (!getApps().length) {
  const serviceAccount: ServiceAccount = {
    projectId: "freshwax-store",
    clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
    privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  };

  initializeApp({
    credential: cert(serviceAccount),
  });
}

export const db = getFirestore();