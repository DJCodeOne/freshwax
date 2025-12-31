// src/pages/api/vinyl/upload-image.ts
// Upload vinyl listing images to R2 CDN
// Converts all images to WebP for optimal storage

import '../../../lib/dom-polyfill';
import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { processImageToWebP } from '../../../lib/image-processing';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../../lib/rate-limit';

export const prerender = false;

// Image settings
const MAX_IMAGE_WIDTH = 1200;
const MAX_IMAGE_HEIGHT = 1200;
const WEBP_QUALITY = 85;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB input limit
const MAX_IMAGES_PER_LISTING = 6;

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

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: 20 image uploads per hour per user
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`vinyl-image:${clientId}`, {
    maxRequests: 20,
    windowMs: 60 * 60 * 1000, // 1 hour
    blockDurationMs: 15 * 60 * 1000 // 15 min block
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
    const imageIndex = parseInt(formData.get('imageIndex') as string || '0', 10);

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

    // Validate image index
    if (imageIndex < 0 || imageIndex >= MAX_IMAGES_PER_LISTING) {
      return new Response(JSON.stringify({
        success: false,
        error: `Image index must be between 0 and ${MAX_IMAGES_PER_LISTING - 1}`
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate file type
    const validTypes = ['image/webp', 'image/png', 'image/jpeg', 'image/jpg', 'image/gif'];
    if (!validTypes.includes(file.type)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid file type. Only WebP, PNG, JPEG, and GIF are allowed.'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return new Response(JSON.stringify({
        success: false,
        error: 'File too large. Maximum 10MB allowed.'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const inputBuffer = await file.arrayBuffer();
    const originalSize = file.size;

    // Process image: resize if needed, convert to WebP
    const processed = await processImageToWebP(inputBuffer, MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT, WEBP_QUALITY);
    const compressedSize = processed.buffer.length;

    // Generate unique filename
    const timestamp = Date.now();
    const filename = `${listingId}_${imageIndex}_${timestamp}.webp`;
    const key = `vinyl/${sellerId}/${filename}`;

    await s3Client.send(
      new PutObjectCommand({
        Bucket: r2Config.bucketName,
        Key: key,
        Body: processed.buffer,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000',
      })
    );

    const publicUrl = `${r2Config.publicDomain}/${key}`;
    const savings = Math.round((1 - compressedSize / originalSize) * 100);

    console.log(`[vinyl/upload-image] Processed: ${(originalSize/1024).toFixed(1)}KB → ${(compressedSize/1024).toFixed(1)}KB (${savings}% smaller)`);

    return new Response(JSON.stringify({
      success: true,
      url: publicUrl,
      key,
      size: compressedSize,
      originalSize,
      dimensions: `${processed.width}x${processed.height}`,
      savings: `${savings}%`,
      imageIndex
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[vinyl/upload-image] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to process and upload image',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
