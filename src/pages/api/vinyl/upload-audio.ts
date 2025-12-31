// src/pages/api/vinyl/upload-audio.ts
// Upload vinyl audio samples to R2 CDN
// Expects pre-converted MP3 at 128kbps from client-side processing

import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../../lib/rate-limit';

export const prerender = false;

// Audio settings
const MAX_DURATION_SECONDS = 90; // 1 minute 30 seconds
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB max for 90s at 128kbps (~1.4MB expected)
const EXPECTED_BITRATE = 128; // 128kbps

// Get R2 configuration
function getR2Config(env: any) {
  return {
    accountId: env?.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
    bucketName: env?.R2_RELEASES_BUCKET || import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
    publicDomain: env?.R2_PUBLIC_DOMAIN || import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk',
  };
}

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

  const env = (locals as any)?.runtime?.env;
  const r2Config = getR2Config(env);
  const s3Client = createS3Client(r2Config);

  try {
    const formData = await request.formData();

    const file = formData.get('file') as File;
    const sellerId = (formData.get('sellerId') as string)?.trim();
    const listingId = (formData.get('listingId') as string)?.trim() || `temp_${Date.now()}`;
    const duration = parseFloat(formData.get('duration') as string || '0');

    if (!file || file.size === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'No file provided'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (!sellerId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Seller ID required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate file type - must be MP3
    if (file.type !== 'audio/mpeg' && file.type !== 'audio/mp3') {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid file type. Only MP3 files are allowed. Please convert your audio to MP3 128kbps before uploading.'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return new Response(JSON.stringify({
        success: false,
        error: `File too large. Maximum ${MAX_FILE_SIZE / (1024 * 1024)}MB allowed (90 seconds at 128kbps).`
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate duration if provided
    if (duration > 0 && duration > MAX_DURATION_SECONDS) {
      return new Response(JSON.stringify({
        success: false,
        error: `Audio too long. Maximum ${MAX_DURATION_SECONDS} seconds (1:30) allowed.`
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Estimate duration from file size as backup check
    const estimatedDuration = estimateDuration(file.size, EXPECTED_BITRATE);
    if (estimatedDuration > MAX_DURATION_SECONDS * 1.5) { // 50% tolerance for bitrate variance
      return new Response(JSON.stringify({
        success: false,
        error: `Audio appears to be too long (estimated ${Math.round(estimatedDuration)}s). Maximum 90 seconds allowed.`
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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

    console.log(`[vinyl/upload-audio] Uploaded: ${(file.size/1024).toFixed(1)}KB, ~${Math.round(estimatedDuration)}s`);

    return new Response(JSON.stringify({
      success: true,
      url: publicUrl,
      key,
      size: file.size,
      duration: duration || Math.round(estimatedDuration),
      format: 'mp3',
      bitrate: EXPECTED_BITRATE
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[vinyl/upload-audio] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to upload audio',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
