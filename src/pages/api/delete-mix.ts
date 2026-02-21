// src/pages/api/delete-mix.ts
// Deletes DJ mix from Firebase and R2 storage

// SECURITY: Requires authentication - user can only delete their own mixes
import '../../lib/dom-polyfill'; // DOM polyfill for AWS SDK on Cloudflare Workers
import type { APIRoute } from 'astro';
import { S3Client, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getDocument, deleteDocument, queryCollection, verifyRequestUser } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { d1DeleteMix } from '../../lib/d1-catalog';
import { kvDelete } from '../../lib/kv-cache';
import { ApiErrors, createLogger } from '../../lib/api-utils';
import { z } from 'zod';

const DeleteMixSchema = z.object({
  mixId: z.string().min(1).max(200),
  folderPath: z.string().max(500).nullish(),
}).passthrough();

const logger = createLogger('delete-mix');

// Max files to delete from R2 per mix (prevent runaway)
const MAX_R2_FILES_TO_DELETE = 50;

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
  const clientId = getClientId(request);

  // Rate limit: destructive operation - 3 per hour
  const rateCheck = checkRateLimit(`delete-mix:${clientId}`, RateLimiters.destructive);
  if (!rateCheck.allowed) {
    logger.error(`[delete-mix] Rate limit exceeded for ${clientId}`);
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  // Initialize Firebase for Cloudflare runtime
  const env = locals.runtime.env;


  // Initialize R2/S3 client for Cloudflare runtime
  const R2_CONFIG = getR2Config(env);
  const s3Client = createS3Client(R2_CONFIG);

  try {
    // SECURITY: Verify the requesting user's identity
    const { userId, error: authError } = await verifyRequestUser(request);

    if (authError || !userId) {
      return ApiErrors.unauthorized(authError || 'Authentication required');
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return ApiErrors.badRequest('Invalid JSON body');
    }

    const parseResult = DeleteMixSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { mixId, folderPath } = parseResult.data;

    logger.info('[delete-mix] Deleting mix:', mixId, 'for user:', userId);

    const mixData = await getDocument('dj-mixes', mixId);

    if (!mixData) {
      logger.info('[delete-mix] Mix not found, may already be deleted');
      return new Response(JSON.stringify({
        success: true,
        message: 'Mix not found (may already be deleted)'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Verify the user owns this mix
    if (mixData.userId !== userId) {
      logger.error('[delete-mix] User', userId, 'does not own mix', mixId, '(owner:', mixData.userId + ')');
      return ApiErrors.forbidden('You do not have permission to delete this mix');
    }

    // SECURITY: Always derive R2 path from verified mix document, never from client input
    const r2FolderPath = mixData?.folder_path || 'dj-mixes/' + mixId;

    logger.info('[delete-mix] R2 folder:', r2FolderPath);

    // Delete files from R2 (with limit to prevent runaway)
    try {
      const listCommand = new ListObjectsV2Command({
        Bucket: R2_CONFIG.bucketName,
        Prefix: r2FolderPath,
        MaxKeys: MAX_R2_FILES_TO_DELETE, // Limit listed files
      });

      const listedObjects = await s3Client.send(listCommand);

      if (listedObjects.Contents && listedObjects.Contents.length > 0) {
        const filesToDelete = listedObjects.Contents.slice(0, MAX_R2_FILES_TO_DELETE);
        logger.info('[delete-mix] Found', listedObjects.Contents.length, 'files, deleting up to', filesToDelete.length);

        let deleted = 0;
        for (const object of filesToDelete) {
          if (object.Key) {
            await s3Client.send(
              new DeleteObjectCommand({
                Bucket: R2_CONFIG.bucketName,
                Key: object.Key,
              })
            );
            deleted++;
          }
        }
        logger.info('[delete-mix] Deleted', deleted, 'R2 files');

        if (listedObjects.IsTruncated) {
          logger.info('[delete-mix] Note: More files may remain (hit limit)');
        }
      }
    } catch (r2Error: unknown) {
      logger.error('[delete-mix] R2 deletion error:', r2Error);
    }

    // Note: Comments subcollection deletion not supported in firebase-rest
    // Comments are stored as subcollection and would need separate handling
    // or migration to top-level collection with mixId reference

    // Delete mix document from Firebase
    await deleteDocument('dj-mixes', mixId);
    logger.info('[delete-mix] Mix deleted from Firebase');

    // Also delete from D1 (secondary, non-blocking)
    const db = env?.DB;
    if (db) {
      try {
        await d1DeleteMix(db, mixId);
        logger.info('[delete-mix] Mix also deleted from D1');
      } catch (d1Error: unknown) {
        logger.error('[delete-mix] D1 delete failed (non-critical):', d1Error);
      }
    }

    // Invalidate KV cache for mixes list so all edge workers serve fresh data
    const MIXES_CACHE = { prefix: 'mixes' };
    await kvDelete('public:50', MIXES_CACHE).catch(() => {});
    await kvDelete('public:20', MIXES_CACHE).catch(() => {});
    await kvDelete('public:100', MIXES_CACHE).catch(() => {});

    return new Response(JSON.stringify({
      success: true,
      message: 'Mix deleted successfully',
      deletedId: mixId,
      deletedFolder: r2FolderPath
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    logger.error('[delete-mix] Error:', error);

    return ApiErrors.serverError('Failed to delete mix');
  }
};
// Support DELETE method with query params
// SECURITY: Requires Authorization header with Bearer token
export const DELETE: APIRoute = async ({ request, url, locals }) => {
  const mixId = url.searchParams.get('id');

  if (!mixId) {
    return ApiErrors.badRequest('Mix ID is required');
  }

  // Create a mock request with JSON body for the POST handler
  // Pass through the Authorization header for authentication
  const mockRequest = new Request(request.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': request.headers.get('Authorization') || ''
    },
    body: JSON.stringify({ mixId })
  });

  // Call the POST handler with full context including locals
  return POST({ request: mockRequest, url, locals } as any);
};

// Support GET method for simple browser/fetch calls
// SECURITY: Requires Authorization header with Bearer token
export const GET: APIRoute = async (context) => {
  return DELETE(context);
};
