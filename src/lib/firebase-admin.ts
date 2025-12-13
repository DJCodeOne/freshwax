// src/lib/firebase-admin.ts
// Shared Firebase Admin SDK initialization
// Uses lazy initialization to prevent build-time errors on Cloudflare Pages

import { initializeApp, getApps, cert, type App } from 'firebase-admin/app';
import { getFirestore, FieldValue as FV, type Firestore } from 'firebase-admin/firestore';

let _app: App | null = null;
let _db: Firestore | null = null;
let _initialized = false;

// Detect if we're in build/prerender context vs runtime
// During Cloudflare Pages build, CF_PAGES is set; during runtime, we have workers runtime
function isBuildTime(): boolean {
  // Check for Node.js build environment indicators
  if (typeof process !== 'undefined' && process.env) {
    // CF_PAGES is set during Cloudflare Pages build
    if (process.env.CF_PAGES === '1') return true;
    // Astro/Vite build indicators
    if (process.env.npm_lifecycle_event === 'build') return true;
  }
  return false;
}

// Initialize Firebase Admin - called lazily on first db access
function ensureInitialized(): void {
  if (_initialized) return;
  _initialized = true;

  // Skip during build time to prevent credential errors
  if (isBuildTime()) {
    console.log('[firebase-admin] Skipping initialization during build');
    return;
  }

  if (getApps().length) {
    _app = getApps()[0];
    _db = getFirestore();
    return;
  }

  const projectId = import.meta.env.FIREBASE_PROJECT_ID;
  const clientEmail = import.meta.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = import.meta.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    console.error('[firebase-admin] Missing required environment variables:', {
      hasProjectId: !!projectId,
      hasClientEmail: !!clientEmail,
      hasPrivateKey: !!privateKey
    });
    return;
  }

  // Handle escaped newlines in the private key (common when set via env vars)
  privateKey = privateKey.replace(/\\n/g, '\n');

  try {
    console.log('[firebase-admin] Attempting initialization with cert...');
    const credential = cert({
      projectId,
      clientEmail,
      privateKey,
    });
    console.log('[firebase-admin] Cert created, initializing app...');
    _app = initializeApp({ credential });
    console.log('[firebase-admin] App initialized, getting Firestore...');
    _db = getFirestore();
    console.log('[firebase-admin] Successfully initialized');
  } catch (error: any) {
    console.error('[firebase-admin] Failed to initialize:', {
      message: error?.message,
      code: error?.code,
      name: error?.name,
      stack: error?.stack?.substring(0, 500)
    });
    // Don't re-throw - let the app continue with _db as null
    // The calling code should handle the null case gracefully
    _app = null;
    _db = null;
  }
}

// Check if Firebase is properly initialized (call this before using adminDb)
export function isFirebaseInitialized(): boolean {
  ensureInitialized();
  return _db !== null;
}

// Export a proxy that lazily initializes on first property access
export const adminDb = new Proxy({} as Firestore, {
  get(_, prop) {
    ensureInitialized();
    if (!_db) {
      // Return null instead of throwing - let calling code handle gracefully
      console.warn('[firebase-admin] Firebase not initialized, returning null for property:', String(prop));
      return null;
    }
    const value = (_db as any)[prop];
    if (typeof value === 'function') {
      return value.bind(_db);
    }
    return value;
  }
});

// Re-export FieldValue for convenience
export { FV as FieldValue };
