// src/pages/api/delete-mix.ts
// Deletes DJ mix from Firebase and R2 storage

import type { APIRoute } from 'astro';
import { S3Client, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getDocument, deleteDocument, queryCollection, initFirebaseEnv } from '../../lib/firebase-rest';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

const R2_CONFIG = {
  accountId: import.meta.env.R2_ACCOUNT_ID,
  accessKeyId: import.meta.env.R2_ACCESS_KEY_ID,
  secretAccessKey: import.meta.env.R2_SECRET_ACCESS_KEY,
  bucketName: import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
};

const s3Client = new S3Client({
  region: 'auto',
  endpoint: 'https://' + R2_CONFIG.accountId + '.r2.cloudflarestorage.com',
  credentials: {
    accessKeyId: R2_CONFIG.accessKeyId,
    secretAccessKey: R2_CONFIG.secretAccessKey,
  },
});

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const { mixId, folderPath } = await request.json();

    if (!mixId) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Mix ID is required' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    log.info('[delete-mix] Deleting mix:', mixId);

    const mixData = await getDocument('dj-mixes', mixId);

    if (!mixData) {
      log.info('[delete-mix] Mix not found, may already be deleted');
      return new Response(JSON.stringify({
        success: true,
        message: 'Mix not found (may already be deleted)'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const r2FolderPath = folderPath || mixData?.folder_path || 'dj-mixes/' + mixId;

    log.info('[delete-mix] R2 folder:', r2FolderPath);

    // Delete files from R2
    try {
      const listCommand = new ListObjectsV2Command({
        Bucket: R2_CONFIG.bucketName,
        Prefix: r2FolderPath,
      });

      const listedObjects = await s3Client.send(listCommand);

      if (listedObjects.Contents && listedObjects.Contents.length > 0) {
        log.info('[delete-mix] Found', listedObjects.Contents.length, 'files to delete');

        for (const object of listedObjects.Contents) {
          if (object.Key) {
            await s3Client.send(
              new DeleteObjectCommand({
                Bucket: R2_CONFIG.bucketName,
                Key: object.Key,
              })
            );
          }
        }
        log.info('[delete-mix] R2 files deleted');
      }
    } catch (r2Error) {
      log.error('[delete-mix] R2 deletion error:', r2Error);
    }

    // Note: Comments subcollection deletion not supported in firebase-rest
    // Comments are stored as subcollection and would need separate handling
    // or migration to top-level collection with mixId reference

    // Delete mix document
    await deleteDocument('dj-mixes', mixId);
    log.info('[delete-mix] Mix deleted');

    return new Response(JSON.stringify({ 
      success: true, 
      message: 'Mix deleted successfully',
      deletedId: mixId,
      deletedFolder: r2FolderPath
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    log.error('[delete-mix] Error:', error);

    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Failed to delete mix',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
// Support DELETE method with query params
export const DELETE: APIRoute = async ({ request, url }) => {
  const mixId = url.searchParams.get('id');
  
  if (!mixId) {
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Mix ID is required' 
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Create a mock request with JSON body for the POST handler
  const mockRequest = new Request(request.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mixId })
  });
  
  // Call the POST handler
  return POST({ request: mockRequest, url } as any);
};

// Support GET method for simple browser/fetch calls
export const GET: APIRoute = async (context) => {
  return DELETE(context);
};
