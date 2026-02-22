// src/pages/api/upload-r2-batch.ts
// Simple R2 upload endpoint for zip uploader - uploads individual files to R2

import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { verifyRequestUser } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger } from '../../lib/api-utils';

const log = createLogger('upload-r2-batch');

export const prerender = false;

// Get R2 configuration from Cloudflare runtime env
function getR2Config(env: Record<string, unknown>) {
  return {
    accountId: env?.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
    bucketName: env?.R2_RELEASES_BUCKET || import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
    publicDomain: env?.R2_PUBLIC_DOMAIN || import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk',
  };
}

function getContentType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop();
  const types: Record<string, string> = {
    'webp': 'image/webp',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'flac': 'audio/flac',
    'json': 'application/json',
  };
  return types[ext || ''] || 'application/octet-stream';
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = locals.runtime.env || {};

    // SECURITY: Rate limit uploads
    const clientId = getClientId(request);
    const rateLimit = checkRateLimit(`upload:${clientId}`, RateLimiters.standard);
    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit.retryAfter!);
    }

    // SECURITY: Require authentication

    const { userId, error: authError } = await verifyRequestUser(request);
    if (!userId || authError) {
      return ApiErrors.unauthorized('Authentication required');
    }

    const R2_CONFIG = getR2Config(env);

    // Validate R2 config
    if (!R2_CONFIG.accountId || !R2_CONFIG.accessKeyId || !R2_CONFIG.secretAccessKey) {
      return ApiErrors.serverError('R2 configuration missing');
    }

    const formData = await request.formData();
    const file = formData.get('file') as File;
    const rawFilename = formData.get('filename') as string;
    const rawReleaseId = formData.get('releaseId') as string;
    const fileType = formData.get('fileType') as string; // metadata, track, preview, artwork

    if (!file || !rawReleaseId) {
      return ApiErrors.badRequest('Missing file or releaseId');
    }

    // SECURITY: Sanitize releaseId and filename to prevent path traversal
    const releaseId = rawReleaseId.replace(/[^a-zA-Z0-9_\-]/g, '');
    const sanitizedName = (rawFilename || file.name).replace(/\.\./g, '').replace(/[\/\\]/g, '_');
    const filename = sanitizedName;

    if (!releaseId) {
      return ApiErrors.badRequest('Invalid releaseId');
    }

    // Create S3 client for R2
    const s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_CONFIG.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_CONFIG.accessKeyId,
        secretAccessKey: R2_CONFIG.secretAccessKey,
      },
    });

    // Determine the key/path in R2
    let subFolder = 'files';
    if (fileType === 'metadata') subFolder = 'metadata';
    else if (fileType === 'track') subFolder = 'tracks';
    else if (fileType === 'preview') subFolder = 'previews';
    else if (fileType === 'artwork') subFolder = 'artwork';

    const key = `releases/${releaseId}/${subFolder}/${filename || file.name}`;
    const contentType = getContentType(filename || file.name);

    // Get file content
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Upload to R2
    const command = new PutObjectCommand({
      Bucket: R2_CONFIG.bucketName,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000',
    });

    await s3Client.send(command);

    const publicUrl = `${R2_CONFIG.publicDomain}/${key}`;

    return new Response(JSON.stringify({
      success: true,
      url: publicUrl,
      key: key,
      size: buffer.length,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    log.error('[upload-r2-batch] Error:', error);
    return ApiErrors.serverError('Upload failed');
  }
};
