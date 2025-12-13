// src/pages/api/admin/reset-store.ts
// DANGER: Reset store - delete all data except admin account

import type { APIRoute } from 'astro';
import { queryCollection, deleteDocument, setDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { DOMParser } from '@xmldom/xmldom';

// Polyfill DOMParser for Cloudflare Workers (AWS SDK needs it for XML parsing)
if (typeof globalThis.DOMParser === 'undefined') {
  (globalThis as any).DOMParser = DOMParser;
}

// Conditional logging - only logs in development
const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

// Get R2 configuration from Cloudflare runtime env
function getR2Config(env: any) {
  return {
    accountId: env?.CLOUDFLARE_ACCOUNT_ID || env?.R2_ACCOUNT_ID || import.meta.env.CLOUDFLARE_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY || '',
    bucketName: env?.R2_BUCKET || import.meta.env.R2_BUCKET || 'freshwax',
  };
}

// Create S3 client with runtime env
function createR2Client(config: ReturnType<typeof getR2Config>) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

// Helper to delete all documents in a collection
async function deleteCollection(collectionName: string, excludeDocIds: string[] = []) {
  const docs = await queryCollection(collectionName, { skipCache: true });

  let count = 0;

  for (const doc of docs) {
    if (!excludeDocIds.includes(doc.id)) {
      await deleteDocument(collectionName, doc.id);
      count++;
    }
  }

  return count;
}

// Helper to clear R2 bucket
async function clearR2Bucket(r2Client: S3Client, bucketName: string) {
  let deletedCount = 0;
  let continuationToken: string | undefined;

  do {
    const listCommand = new ListObjectsV2Command({
      Bucket: bucketName,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    });

    const listResponse = await r2Client.send(listCommand);

    if (listResponse.Contents && listResponse.Contents.length > 0) {
      const deleteCommand = new DeleteObjectsCommand({
        Bucket: bucketName,
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

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const env = (locals as any)?.runtime?.env;
  initFirebase(locals);

  // Initialize R2 client for Cloudflare runtime
  const r2Config = getR2Config(env);
  const r2Client = createR2Client(r2Config);

  try {
    log.info('[reset-store] Starting store reset...');

    // Find admin account to preserve
    const adminEmail = import.meta.env.ADMIN_EMAIL || 'admin@freshwax.com';
    let adminId: string | null = null;

    // Look for admin in customers collection
    const customers = await queryCollection('customers', {
      filters: [{ field: 'email', op: 'EQUAL', value: adminEmail }],
      skipCache: true
    });
    if (customers.length > 0) {
      adminId = customers[0].id;
      log.info('[reset-store] Found admin account:', adminId);
    }

    // Also check for admin role
    const adminRoleCustomers = await queryCollection('customers', {
      filters: [{ field: 'role', op: 'EQUAL', value: 'admin' }],
      skipCache: true
    });
    const adminIds: string[] = [];
    if (adminId) adminIds.push(adminId);
    adminRoleCustomers.forEach((doc: any) => {
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
      results.r2Files = await clearR2Bucket(r2Client, r2Config.bucketName);
    } catch (r2Error: any) {
      console.error('[reset-store] R2 clear error:', r2Error);
      // Continue even if R2 fails
    }

    // Reset counters in settings
    await setDocument('settings', 'counters', {
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
