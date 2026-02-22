// src/pages/api/vinyl/upload-audio.ts
// Upload vinyl audio samples to R2 CDN
// Expects pre-converted MP3 at 128kbps from client-side processing

import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../../lib/rate-limit';
import { verifyRequestUser } from '../../../lib/firebase-rest';
import { createLogger, ApiErrors, getR2Config, successResponse } from '../../../lib/api-utils';

const log = createLogger('[vinyl-upload-audio]');

export const prerender = false;

// Audio settings
const MAX_DURATION_SECONDS = 90; // 1 minute 30 seconds
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB max for 90s at 128kbps (~1.4MB expected)
const EXPECTED_BITRATE = 128; // 128kbps


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

// Estimate duration from file size at 128kbps
function estimateDuration(fileSize: number, bitrate: number = 128): number {
  // bitrate is in kbps, so bytes per second = bitrate * 1000 / 8
  const bytesPerSecond = (bitrate * 1000) / 8;
  return fileSize / bytesPerSecond;
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: 10 audio uploads per hour per user
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`vinyl-audio:${clientId}`, {
    maxRequests: 10,
    windowMs: 60 * 60 * 1000, // 1 hour
    blockDurationMs: 30 * 60 * 1000 // 30 min block
  });

  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;

  // Require authenticated user
  const { userId, error: authError } = await verifyRequestUser(request);
  if (authError || !userId) {
    return ApiErrors.unauthorized('Authentication required');
  }

  const r2Config = getR2Config(env);
  const s3Client = createS3Client(r2Config);

  try {
    const formData = await request.formData();

    const file = formData.get('file') as File;
    const sellerId = (formData.get('sellerId') as string)?.trim();
    const listingId = (formData.get('listingId') as string)?.trim() || `temp_${Date.now()}`;
    const duration = parseFloat(formData.get('duration') as string || '0');

    if (!file || file.size === 0) {
      return ApiErrors.badRequest('No file provided');
    }

    if (!sellerId) {
      return ApiErrors.badRequest('Seller ID required');
    }

    // Verify seller owns this upload
    if (sellerId !== userId) {
      return ApiErrors.forbidden('You can only upload audio for your own listings');
    }

    // Validate file type - must be MP3
    if (file.type !== 'audio/mpeg' && file.type !== 'audio/mp3') {
      return ApiErrors.badRequest('Invalid file type. Only MP3 files are allowed. Please convert your audio to MP3 128kbps before uploading.');
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return ApiErrors.badRequest('File too large. Maximum ${MAX_FILE_SIZE / (1024 * 1024)}MB allowed (90 seconds at 128kbps).');
    }

    // Validate duration if provided
    if (duration > 0 && duration > MAX_DURATION_SECONDS) {
      return ApiErrors.badRequest('Audio too long. Maximum ${MAX_DURATION_SECONDS} seconds (1:30) allowed.');
    }

    // Estimate duration from file size as backup check
    const estimatedDuration = estimateDuration(file.size, EXPECTED_BITRATE);
    if (estimatedDuration > MAX_DURATION_SECONDS * 1.5) { // 50% tolerance for bitrate variance
      return ApiErrors.badRequest('Audio appears to be too long (estimated ${Math.round(estimatedDuration)}s). Maximum 90 seconds allowed.');
    }

    const audioBuffer = await file.arrayBuffer();

    // Generate unique filename
    const timestamp = Date.now();
    const filename = `${listingId}_sample_${timestamp}.mp3`;
    const key = `vinyl/${sellerId}/audio/${filename}`;

    await s3Client.send(
      new PutObjectCommand({
        Bucket: r2Config.bucketName,
        Key: key,
        Body: new Uint8Array(audioBuffer),
        ContentType: 'audio/mpeg',
        CacheControl: 'public, max-age=31536000',
      })
    );

    const publicUrl = `${r2Config.publicDomain}/${key}`;

    log.info(`Uploaded: ${(file.size/1024).toFixed(1)}KB, ~${Math.round(estimatedDuration)}s`);

    return successResponse({ url: publicUrl,
      key,
      size: file.size,
      duration: duration || Math.round(estimatedDuration),
      format: 'mp3',
      bitrate: EXPECTED_BITRATE });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to upload audio');
  }
};
