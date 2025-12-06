// src/pages/api/admin/reset-store.ts
// DANGER: Reset store - delete all data except admin account

import type { APIRoute } from 'astro';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

// Conditional logging - only logs in development
const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

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

// Initialize R2 client
const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${import.meta.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: import.meta.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: import.meta.env.R2_SECRET_ACCESS_KEY || '',
  },
});

const R2_BUCKET = import.meta.env.R2_BUCKET || 'freshwax';

// Helper to delete all documents in a collection
async function deleteCollection(collectionName: string, excludeDocIds: string[] = []) {
  const collectionRef = db.collection(collectionName);
  const snapshot = await collectionRef.get();
  
  const batch = db.batch();
  let count = 0;
  
  for (const doc of snapshot.docs) {
    if (!excludeDocIds.includes(doc.id)) {
      batch.delete(doc.ref);
      count++;
      
      // Firestore batch limit is 500
      if (count >= 400) {
        await batch.commit();
        count = 0;
      }
    }
  }
  
  if (count > 0) {
    await batch.commit();
  }
  
  return snapshot.size - excludeDocIds.filter(id => snapshot.docs.some(d => d.id === id)).length;
}

// Helper to clear R2 bucket
async function clearR2Bucket() {
  let deletedCount = 0;
  let continuationToken: string | undefined;
  
  do {
    const listCommand = new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    });
    
    const listResponse = await r2Client.send(listCommand);
    
    if (listResponse.Contents && listResponse.Contents.length > 0) {
      const deleteCommand = new DeleteObjectsCommand({
        Bucket: R2_BUCKET,
        Delete: {
          Objects: listResponse.Contents.map(obj => ({ Key: obj.Key })),
          Quiet: true,
        },
      });
      
      await r2Client.send(deleteCommand);
      deletedCount += listResponse.Contents.length;
    }
    
    continuationToken = listResponse.NextContinuationToken;
  } while (continuationToken);
  
  return deletedCount;
}

export const POST: APIRoute = async ({ request, cookies }) => {
  try {
    log.info('[reset-store] Starting store reset...');
    
    // Find admin account to preserve
    const adminEmail = import.meta.env.ADMIN_EMAIL || 'admin@freshwax.com';
    let adminId: string | null = null;
    
    // Look for admin in customers collection
    const customersSnapshot = await db.collection('customers').where('email', '==', adminEmail).get();
    if (!customersSnapshot.empty) {
      adminId = customersSnapshot.docs[0].id;
      log.info('[reset-store] Found admin account:', adminId);
    }
    
    // Also check for admin role
    const adminRoleSnapshot = await db.collection('customers').where('role', '==', 'admin').get();
    const adminIds: string[] = [];
    if (adminId) adminIds.push(adminId);
    adminRoleSnapshot.docs.forEach(doc => {
      if (!adminIds.includes(doc.id)) {
        adminIds.push(doc.id);
      }
    });
    
    log.info('[reset-store] Preserving admin accounts:', adminIds);
    
    const results = {
      customers: 0,
      orders: 0,
      releases: 0,
      tracks: 0,
      djMixes: 0,
      merch: 0,
      artists: 0,
      partners: 0,
      downloads: 0,
      comments: 0,
      r2Files: 0,
    };
    
    // Delete collections (preserving admin accounts)
    log.info('[reset-store] Deleting customers...');
    results.customers = await deleteCollection('customers', adminIds);
    
    log.info('[reset-store] Deleting orders...');
    results.orders = await deleteCollection('orders');
    
    log.info('[reset-store] Deleting releases...');
    results.releases = await deleteCollection('releases');
    
    log.info('[reset-store] Deleting tracks...');
    results.tracks = await deleteCollection('tracks');
    
    log.info('[reset-store] Deleting DJ mixes...');
    results.djMixes = await deleteCollection('dj-mixes');
    
    log.info('[reset-store] Deleting merch...');
    results.merch = await deleteCollection('merch');
    
    log.info('[reset-store] Deleting artists...');
    results.artists = await deleteCollection('artists');
    
    log.info('[reset-store] Deleting partners...');
    results.partners = await deleteCollection('partners');
    
    log.info('[reset-store] Deleting downloads...');
    results.downloads = await deleteCollection('downloads');
    
    log.info('[reset-store] Deleting comments...');
    results.comments = await deleteCollection('comments');
    
    // Clear R2 storage
    log.info('[reset-store] Clearing R2 storage...');
    try {
      results.r2Files = await clearR2Bucket();
    } catch (r2Error: any) {
      console.error('[reset-store] R2 clear error:', r2Error);
      // Continue even if R2 fails
    }
    
    // Reset counters in settings
    await db.collection('settings').doc('counters').set({
      releases: 0,
      orders: 0,
      customers: adminIds.length,
      resetAt: new Date()
    });
    
    log.info('[reset-store] Reset complete:', results);
    
    return new Response(JSON.stringify({
      success: true,
      message: 'Store has been reset',
      deleted: results
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[reset-store] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to reset store'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
