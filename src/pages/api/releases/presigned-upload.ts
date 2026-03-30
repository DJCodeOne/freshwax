// src/pages/api/releases/presigned-upload.ts
// Generate presigned URLs for direct R2 uploads (bypasses 100MB Worker limit)

import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { verifyRequestUser } from '../../../lib/firebase-rest';
import { getAdminKey, ApiErrors, createLogger, getR2Config, successResponse } from '../../../lib/api-utils';
import { verifyAdminKey } from '../../../lib/admin';
import { z } from 'zod';

const FileItemSchema = z.object({
  filename: z.string().min(1).max(500),
  contentType: z.string().min(1).max(200),
  size: z.number().int().min(0).nullish(),
}).strip();

const PresignedUploadSchema = z.object({
  files: z.array(FileItemSchema).min(1).max(100),
  artistName: z.string().max(200).nullish(),
  releaseName: z.string().max(500).nullish(),
  uploadType: z.string().max(50).default('release'),
  releaseId: z.string().max(200).nullish(),
}).strip();

export const prerender = false;

const log = createLogger('presigned-upload');

// Supported file types
const ALLOWED_TYPES: Record<string, string> = {
  // Audio
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/aiff': '.aiff',
  'audio/x-aiff': '.aiff',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  // Images
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  // Archives (for batch uploads)
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
};


function sanitize(str: string): string {
  return str.replace(/[^a-zA-Z0-9]/g, '').substring(0, 30);
}

function sanitizeFilename(str: string): string {
  return str.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 100);
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`presigned-upload:${clientId}`, RateLimiters.upload);
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
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

  try {
    const r2Config = getR2Config(env);

    if (!r2Config.accountId || !r2Config.accessKeyId || !r2Config.secretAccessKey) {
      log.error('R2 credentials not configured');
      return ApiErrors.serverError('Storage not configured');
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch (e: unknown) {
      return ApiErrors.badRequest('Invalid JSON body');
    }

    const parseResult = PresignedUploadSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const {
      files,
      artistName,
      releaseName,
      uploadType = 'release',
      releaseId,
    } = parseResult.data;

    // Dedup check: prevent same artist+title from being uploaded twice within 10 minutes
    if (!isAdmin && !releaseId && artistName && releaseName) {
      const dedupKey = `upload-dedup:${sanitize(artistName)}:${sanitize(releaseName)}`;
      const dedupCheck = checkRateLimit(dedupKey, RateLimiters.uploadDedup);
      if (!dedupCheck.allowed) {
        return ApiErrors.conflict(
          'This release was uploaded recently. Wait 10 minutes before retrying, or use a different title.'
        );
      }
    }

    // Validate all file types
    for (const file of files) {
      if (!ALLOWED_TYPES[file.contentType]) {
        return ApiErrors.badRequest(`Unsupported file type: ${file.contentType}. Supported: MP3, WAV, FLAC, AIFF, M4A, JPG, PNG, WEBP, ZIP`);
      }
    }

    // Generate release ID
    const finalReleaseId = releaseId || `${sanitize(artistName || 'upload')}_FW-${Date.now()}`;

    // All releases go to releases/ folder with proper organization
    const baseFolder = `releases/${finalReleaseId}`;

    // Create S3 client
    const s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${r2Config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: r2Config.accessKeyId,
        secretAccessKey: r2Config.secretAccessKey,
      },
    });

    // Generate presigned URLs for each file
    const uploadUrls: Array<{
      filename: string;
      uploadUrl: string;
      publicUrl: string;
      key: string;
      contentType: string;
    }> = [];

    for (const file of files) {
      const ext = ALLOWED_TYPES[file.contentType];
      const safeFilename = sanitizeFilename(file.filename.replace(/\.[^.]+$/, '')) + ext;

      // Determine path based on file type - organized in subfolders
      let key: string;
      if (file.contentType.startsWith('image/')) {
        key = `${baseFolder}/artwork/${safeFilename}`;
      } else if (file.contentType.startsWith('audio/')) {
        key = `${baseFolder}/tracks/${safeFilename}`;
      } else if (file.contentType.includes('zip')) {
        key = `${baseFolder}/source/${safeFilename}`;
      } else {
        key = `${baseFolder}/other/${safeFilename}`;
      }

      const command = new PutObjectCommand({
        Bucket: r2Config.bucketName,
        Key: key,
        ContentType: file.contentType,
      });

      // Generate presigned URL valid for 1 hour
      const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

      uploadUrls.push({
        filename: file.filename,
        uploadUrl,
        publicUrl: `${r2Config.publicDomain}/${key}`,
        key,
        contentType: file.contentType,
      });

      log.info(`Generated presigned URL for: ${key}`);
    }

    return successResponse({
      releaseId: finalReleaseId,
      baseFolder,
      uploads: uploadUrls,
      expiresIn: 3600,
    });

  } catch (error: unknown) {
    log.error('Failed to generate presigned URLs:', error);
    return ApiErrors.serverError('Failed to generate upload URLs');
  }
};
