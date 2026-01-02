// src/pages/api/upload-merch-image.ts
// Upload processed merch images to R2 CDN
// Converts all images to square WebP for consistency
// Uses WASM-based image processing for Cloudflare Workers compatibility

import '../../lib/dom-polyfill';
import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { processImageToSquareWebP } from '../../lib/image-processing';
import { requireAdminAuth } from '../../lib/admin';

export const prerender = false;

// Image processing settings
const IMAGE_SIZE = 800; // 800x800 square
const WEBP_QUALITY = 85; // Good balance of quality and size

// Get R2 configuration from Cloudflare runtime env
function getR2Config(env: any) {
  return {
    accountId: env?.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
    bucketName: env?.R2_RELEASES_BUCKET || import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
    publicDomain: env?.R2_PUBLIC_DOMAIN || import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk',
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
  // Admin authentication required
  const authError = requireAdminAuth(request, locals);
  if (authError) return authError;

  const env = (locals as any)?.runtime?.env;
  const r2Config = getR2Config(env);
  const s3Client = createS3Client(r2Config);

  try {
    const formData = await request.formData();

    const file = formData.get('file') as File;
    const folder = (formData.get('folder') as string) || 'merch';
    let filename = (formData.get('filename') as string) || file?.name || 'image.webp';

    if (!file || file.size === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'No file provided'
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

    // Max 10MB input (will be compressed)
    if (file.size > 10 * 1024 * 1024) {
      return new Response(JSON.stringify({
        success: false,
        error: 'File too large. Maximum 10MB allowed.'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const inputBuffer = await file.arrayBuffer();
    const originalSize = file.size;

    // Process image: crop to square, resize to 800x800, convert to WebP
    const processed = await processImageToSquareWebP(inputBuffer, IMAGE_SIZE, WEBP_QUALITY);
    const compressedSize = processed.buffer.length;

    // Ensure filename ends with .webp
    filename = filename.replace(/\.[^.]+$/, '') + '.webp';

    // Sanitize folder and filename
    const sanitizedFolder = folder.replace(/[^a-zA-Z0-9-_\/]/g, '-').toLowerCase();
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9-_.]/g, '-').toLowerCase();

    const key = `${sanitizedFolder}/${sanitizedFilename}`;

    await s3Client.send(
      new PutObjectCommand({
        Bucket: r2Config.bucketName,
        Key: key,
        Body: processed.buffer,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000', // 1 year cache
      })
    );

    const publicUrl = `${r2Config.publicDomain}/${key}`;

    // Calculate compression stats
    const savings = Math.round((1 - compressedSize / originalSize) * 100);

    console.log(`[upload-merch-image] Processed: → ${IMAGE_SIZE}x${IMAGE_SIZE}, ${(originalSize/1024).toFixed(1)}KB → ${(compressedSize/1024).toFixed(1)}KB (${savings}% smaller)`);

    return new Response(JSON.stringify({
      success: true,
      url: publicUrl,
      key: key,
      size: compressedSize,
      originalSize: originalSize,
      dimensions: `${IMAGE_SIZE}x${IMAGE_SIZE}`,
      contentType: 'image/webp',
      savings: `${savings}%`
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[upload-merch-image] Error:', error);

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
