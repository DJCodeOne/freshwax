// src/pages/api/releases/presign-upload.ts
// Generate presigned URLs for SINGLE file uploads to R2
// Used by: ReleaseUploadForm.jsx (partner/pro uploads)
// For BATCH uploads with validation, use: presigned-upload.ts

import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { verifyRequestUser } from '../../../lib/firebase-rest';
import { getAdminKey, errorResponse, ApiErrors } from '../../../lib/api-utils';
import { verifyAdminKey } from '../../../lib/admin';

export const prerender = false;

function getR2Config(env: any) {
  return {
    accountId: env?.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
    uploadsBucket: env?.R2_UPLOADS_BUCKET || import.meta.env.R2_UPLOADS_BUCKET || 'freshwax-uploads',
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: upload operations - 10 per hour
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`presign-upload:${clientId}`, RateLimiters.upload);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;

  // Check for admin key first (for admin upload page) - timing-safe comparison
  const adminKey = getAdminKey(request);
  const isAdmin = adminKey ? verifyAdminKey(adminKey, locals) : false;

  // If not admin, require authenticated user
  if (!isAdmin) {
    const { userId, error: authError } = await verifyRequestUser(request);
    if (authError || !userId) {
      return ApiErrors.unauthorized(authError || 'Authentication required');
    }
  }

  // Reject oversized JSON bodies (max 1MB for metadata-only requests)
  const reqContentLength = parseInt(request.headers.get('Content-Length') || '0');
  if (reqContentLength > 1 * 1024 * 1024) {
    return errorResponse('Request body too large', 413);
  }

  try {
    const { key, contentType, contentLength, bucket } = await request.json();

    if (!key || !contentType) {
      return ApiErrors.badRequest('key and contentType are required');
    }

    // Validate declared file size if provided (500MB max for releases)
    const MAX_RELEASE_FILE_SIZE = 500 * 1024 * 1024;
    if (contentLength && contentLength > MAX_RELEASE_FILE_SIZE) {
      return errorResponse('File too large. Maximum file size is 500MB.', 413);
    }

    // SECURITY: Validate the key to prevent path traversal and uploading to arbitrary locations
    // Decode URL-encoded characters first to prevent bypass via %2e%2e etc.
    const decodedKey = decodeURIComponent(key);
    const ALLOWED_PREFIXES = ['releases/', 'submissions/', 'dj-mixes/', 'vinyl/', 'merch/', 'avatars/'];
    const normalizedKey = decodedKey.replace(/\\/g, '/'); // Normalize backslashes
    if (
      normalizedKey.includes('\0') ||
      normalizedKey.includes('..') ||
      normalizedKey.startsWith('/') ||
      !ALLOWED_PREFIXES.some((prefix: string) => normalizedKey.startsWith(prefix))
    ) {
      return ApiErrors.badRequest('Invalid upload path');
    }

    const config = getR2Config(env);

    console.log('[Presign] Request bucket param:', bucket);
    console.log('[Presign] Config uploadsBucket:', config.uploadsBucket);

    if (!config.accountId || !config.accessKeyId || !config.secretAccessKey) {
      console.error('[Presign] Missing R2 credentials');
      return ApiErrors.serverError('R2 configuration missing');
    }

    // Use releases bucket for everything (submissions go to submissions/ folder)
    const bucketName = 'freshwax-releases';

    const s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      ContentType: contentType,
    });

    // Generate presigned URL valid for 1 hour
    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

    console.log(`[Presign] Generated URL for ${bucketName}/${key}`);

    return new Response(JSON.stringify({ uploadUrl, key }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    console.error('[Presign] Error:', error);
    return ApiErrors.serverError('Failed to generate upload URL');
  }
};
