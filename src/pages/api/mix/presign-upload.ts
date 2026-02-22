// src/pages/api/mix/presign-upload.ts
// Generate presigned URLs for DJ mix uploads (for large files that exceed Worker limits)

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { verifyRequestUser } from '../../../lib/firebase-rest';
import { createLogger, errorResponse, ApiErrors } from '../../../lib/api-utils';

const log = createLogger('[mix-presign]');

const ALLOWED_AUDIO_CONTENT_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav'] as const;

const PresignUploadSchema = z.object({
  fileName: z.string().min(1).max(500),
  contentType: z.string().min(1).max(100),
  fileSize: z.number().positive().nullish(),
  mixId: z.string().max(500).nullish(),
  artworkFileName: z.string().max(500).nullish(),
  artworkContentType: z.string().max(100).nullish(),
}).passthrough();

export const prerender = false;

function getR2Config(env: Record<string, unknown>) {
  return {
    accountId: env?.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
    bucketName: env?.R2_RELEASES_BUCKET || import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
    publicDomain: env?.R2_PUBLIC_DOMAIN || import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk',
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`mix-presign:${clientId}`, RateLimiters.upload);
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  const env = locals.runtime.env;

  // Require authenticated user (all registered users can upload mixes)
  const { userId, error: authError } = await verifyRequestUser(request);
  if (authError || !userId) {
    return ApiErrors.unauthorized(authError || 'Authentication required');
  }

  // Reject oversized JSON bodies (max 1MB for metadata-only requests)
  const reqContentLength = parseInt(request.headers.get('Content-Length') || '0');
  if (reqContentLength > 1 * 1024 * 1024) {
    return errorResponse('Request body too large', 413);
  }

  try {
    const rawBody = await request.json();
    const parseResult = PresignUploadSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { fileName, contentType, fileSize, mixId, artworkFileName, artworkContentType } = parseResult.data;

    // Validate file size (500MB max for large file upload path)
    const MAX_LARGE_FILE_SIZE = 500 * 1024 * 1024; // 500MB
    if (fileSize && fileSize > MAX_LARGE_FILE_SIZE) {
      return ApiErrors.badRequest('File too large. Maximum file size is 500MB.');
    }

    // Validate content type is audio
    const allowedAudioTypes = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav'];
    if (!allowedAudioTypes.includes(contentType) && !fileName.toLowerCase().match(/\.(mp3|wav)$/)) {
      return ApiErrors.badRequest('Invalid audio format. Only MP3 and WAV files are allowed.');
    }

    // Validate filename has a valid extension
    const validExtensions = /\.(mp3|wav)$/i;
    if (!validExtensions.test(fileName)) {
      return ApiErrors.badRequest('Invalid file extension. Only .mp3 and .wav files are allowed.');
    }

    const config = getR2Config(env);

    if (!config.accountId || !config.accessKeyId || !config.secretAccessKey) {
      log.error('Missing R2 credentials');
      return ApiErrors.serverError('R2 configuration missing');
    }

    // Generate a unique folder path for this mix
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(2, 10);
    const finalMixId = mixId || `mix_${timestamp}_${randomId}`;
    const folderPath = `dj-mixes/${finalMixId}`;

    // Clean filename
    const cleanFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const audioKey = `${folderPath}/${cleanFileName}`;

    const s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });

    const command = new PutObjectCommand({
      Bucket: config.bucketName,
      Key: audioKey,
      ContentType: contentType,
    });

    // Generate presigned URL valid for 2 hours (large files may take time)
    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 7200 });

    // Build the public URL
    const publicUrl = `${config.publicDomain}/${audioKey}`;

    // Generate artwork presigned URL if artwork info provided
    let artworkUploadUrl = null;
    let artworkPublicUrl = null;
    if (artworkFileName && artworkContentType) {
      const artworkExt = artworkFileName.split('.').pop() || 'jpg';
      const artworkKey = `${folderPath}/artwork.${artworkExt}`;

      const artworkCommand = new PutObjectCommand({
        Bucket: config.bucketName,
        Key: artworkKey,
        ContentType: artworkContentType,
      });

      artworkUploadUrl = await getSignedUrl(s3Client, artworkCommand, { expiresIn: 7200 });
      artworkPublicUrl = `${config.publicDomain}/${artworkKey}`;
      log.info(`Also generated artwork URL for ${artworkKey}`);
    }

    log.info(`Generated URL for ${audioKey} (${(fileSize / 1024 / 1024).toFixed(1)}MB)`);

    return new Response(JSON.stringify({
      success: true,
      uploadUrl,
      key: audioKey,
      publicUrl,
      mixId: finalMixId,
      folderPath,
      artworkUploadUrl,
      artworkPublicUrl
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Unknown error');
  }
};
