// src/lib/firebase-admin.ts
// Shared Firebase Admin SDK initialization
// Uses dynamic imports and lazy initialization for Cloudflare Workers compatibility

import type { App } from 'firebase-admin/app';
import type { Firestore, FieldValue as FVType, Timestamp as TSType } from 'firebase-admin/firestore';

let _app: App | null = null;
let _db: Firestore | null = null;
let _FieldValue: typeof FVType | null = null;
let _Timestamp: typeof TSType | null = null;
let _initialized = false;
let _initError: string | null = null;

// Detect if we're in build/prerender context vs runtime
function isBuildTime(): boolean {
  if (typeof process !== 'undefined' && process.env) {
    if (process.env.CF_PAGES === '1') return true;
    if (process.env.npm_lifecycle_event === 'build') return true;
  }
  return false;
}

// Initialize Firebase Admin - called lazily on first db access
async function ensureInitializedAsync(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  // Skip during build time to prevent credential errors
  if (isBuildTime()) {
    console.log('[firebase-admin] Skipping initialization during build');
    return;
  }

  const projectId = import.meta.env.FIREBASE_PROJECT_ID;
  const clientEmail = import.meta.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = import.meta.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    _initError = 'Missing environment variables';
    console.error('[firebase-admin] Missing required environment variables:', {
      hasProjectId: !!projectId,
      hasClientEmail: !!clientEmail,
      hasPrivateKey: !!privateKey
    });
    return;
  }

  // Handle escaped newlines in the private key
  privateKey = privateKey.replace(/\\n/g, '\n');

  try {
    console.log('[firebase-admin] Dynamically importing firebase-admin...');

    // Dynamic imports to catch any import-time errors
    const [appModule, firestoreModule] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/firestore')
    ]);

    console.log('[firebase-admin] Imports successful, checking existing apps...');

    const { initializeApp, getApps, cert } = appModule;
    const { getFirestore, FieldValue, Timestamp } = firestoreModule;

    _FieldValue = FieldValue;
    _Timestamp = Timestamp;

    if (getApps().length) {
      console.log('[firebase-admin] Using existing app');
      _app = getApps()[0];
      _db = getFirestore();
      return;
    }

    console.log('[firebase-admin] Creating credential...');
    const credential = cert({
      projectId,
      clientEmail,
      privateKey,
    });

    console.log('[firebase-admin] Initializing app...');
    _app = initializeApp({ credential });

    console.log('[firebase-admin] Getting Firestore...');
    _db = getFirestore();

    console.log('[firebase-admin] Successfully initialized');
  } catch (error: any) {
    _initError = error?.message || 'Unknown error';
    console.error('[firebase-admin] Failed to initialize:', {
      message: error?.message,
      code: error?.code,
      name: error?.name,
      stack: error?.stack?.substring(0, 500)
    });
    _app = null;
    _db = null;
  }
}

// Synchronous check - only returns true if already initialized successfully
export function isFirebaseInitialized(): boolean {
  return _db !== null;
}

// Async initialization check
export async function ensureFirebaseInitialized(): Promise<boolean> {
  await ensureInitializedAsync();
  return _db !== null;
}

// Get the Firestore instance (async)
export async function getAdminDb(): Promise<Firestore | null> {
  await ensureInitializedAsync();
  return _db;
}

// Get FieldValue (async)
export async function getFieldValue(): Promise<typeof FVType | null> {
  await ensureInitializedAsync();
  return _FieldValue;
}

// Get Timestamp (async)
export async function getTimestamp(): Promise<typeof TSType | null> {
  await ensureInitializedAsync();
  return _Timestamp;
}

// Legacy proxy export for backward compatibility - but callers should migrate to async
export const adminDb = new Proxy({} as Firestore, {
  get(_, prop) {
    // This is a sync access - if not initialized, return null
    if (!_db) {
      if (!_initialized) {
        console.warn('[firebase-admin] Sync access before initialization. Use getAdminDb() instead.');
      }
      return null;
    }
    const value = (_db as any)[prop];
    if (typeof value === 'function') {
      return value.bind(_db);
    }
    return value;
  }
});

// For backward compatibility
export const FieldValue = new Proxy({} as typeof FVType, {
  get(_, prop) {
    if (!_FieldValue) {
      console.warn('[firebase-admin] FieldValue accessed before initialization');
      return undefined;
    }
    return (_FieldValue as any)[prop];
  }
});
