// src/pages/api/admin/delete-mix.ts
// Admin endpoint to delete DJ mix - forwards to main delete-mix endpoint

export const prerender = false;

import '../../../lib/dom-polyfill'; // DOM polyfill for AWS SDK on Cloudflare Workers
import type { APIRoute } from 'astro';
import { S3Client, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getDocument, deleteDocument, initFirebaseEnv, invalidateMixesCache } from '../../../lib/firebase-rest';
import { requireAdminAuth } from '../../../lib/admin';
import { parseJsonBody } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

// Get R2 configuration from Cloudflare runtime env
function getR2Config(env: any) {
  return {
    accountId: env?.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
    bucketName: env?.R2_BUCKET_NAME || env?.R2_RELEASES_BUCKET || import.meta.env.R2_BUCKET_NAME || import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
  };
}

// Create S3 client with runtime env
function createS3Client(config: ReturnType<typeof getR2Config>) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: admin delete operations - 20 per hour
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`admin-delete-mix:${clientId}`, RateLimiters.adminDelete);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // Admin authentication
  const body = await parseJsonBody(request);
  const authError = requireAdminAuth(request, locals, body);
  if (authError) return authError;

  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  // Initialize R2/S3 client for Cloudflare runtime
  const R2_CONFIG = getR2Config(env);
  const s3Client = createS3Client(R2_CONFIG);

  try {
    const { mixId, folderPath } = body;

    if (!mixId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Mix ID is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    log.info('[admin/delete-mix] Deleting mix:', mixId);

    const mixData = await getDocument('dj-mixes', mixId);

    if (!mixData) {
      log.info('[admin/delete-mix] Mix not found, may already be deleted');
      return new Response(JSON.stringify({
        success: true,
        message: 'Mix not found (may already be deleted)'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const r2FolderPath = folderPath || mixData?.folder_path || 'dj-mixes/' + mixId;

    log.info('[admin/delete-mix] R2 folder:', r2FolderPath);

    // Delete files from R2
    try {
      const listCommand = new ListObjectsV2Command({
        Bucket: R2_CONFIG.bucketName,
        Prefix: r2FolderPath,
      });

      const listedObjects = await s3Client.send(listCommand);

      if (listedObjects.Contents && listedObjects.Contents.length > 0) {
        log.info('[admin/delete-mix] Found', listedObjects.Contents.length, 'files to delete');

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
        log.info('[admin/delete-mix] R2 files deleted');
      }
    } catch (r2Error) {
      log.error('[admin/delete-mix] R2 deletion error:', r2Error);
    }

    // Delete mix document
    await deleteDocument('dj-mixes', mixId);
    log.info('[admin/delete-mix] Mix deleted');

    // Clear mixes cache so changes appear immediately
    invalidateMixesCache();

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
    console.error('[admin/delete-mix] Error:', error);
    console.error('[admin/delete-mix] Stack:', error instanceof Error ? error.stack : 'No stack');

    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to delete mix',
      details: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
