// src/pages/api/upload-merch-image.ts
// Upload processed merch images to R2 CDN
// Converts all images to square WebP for consistency

import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';

export const prerender = false;

const R2_CONFIG = {
  accountId: import.meta.env.R2_ACCOUNT_ID,
  accessKeyId: import.meta.env.R2_ACCESS_KEY_ID,
  secretAccessKey: import.meta.env.R2_SECRET_ACCESS_KEY,
  bucketName: import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
  publicDomain: import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk',
};

const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_CONFIG.accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_CONFIG.accessKeyId,
    secretAccessKey: R2_CONFIG.secretAccessKey,
  },
});

// Image processing settings
const IMAGE_SIZE = 800; // 800x800 square
const WEBP_QUALITY = 85; // Good balance of quality and size

export const POST: APIRoute = async ({ request }) => {
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
    
    const inputBuffer = Buffer.from(await file.arrayBuffer());
    
    // Process image with Sharp
    // 1. Get metadata to determine crop strategy
    const metadata = await sharp(inputBuffer).metadata();
    const { width = 0, height = 0 } = metadata;
    
    // 2. Calculate square crop (center crop)
    const size = Math.min(width, height);
    const left = Math.floor((width - size) / 2);
    const top = Math.floor((height - size) / 2);
    
    // 3. Process: crop to square, resize, convert to WebP
    const processedBuffer = await sharp(inputBuffer)
      .extract({ left, top, width: size, height: size }) // Center crop to square
      .resize(IMAGE_SIZE, IMAGE_SIZE, {
        fit: 'cover',
        position: 'center'
      })
      .webp({ 
        quality: WEBP_QUALITY,
        effort: 4 // Balance between speed and compression
      })
      .toBuffer();
    
    // Ensure filename ends with .webp
    filename = filename.replace(/\.[^.]+$/, '') + '.webp';
    
    // Sanitize folder and filename
    const sanitizedFolder = folder.replace(/[^a-zA-Z0-9-_\/]/g, '-').toLowerCase();
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9-_.]/g, '-').toLowerCase();
    
    const key = `${sanitizedFolder}/${sanitizedFilename}`;
    
    await s3Client.send(
      new PutObjectCommand({
        Bucket: R2_CONFIG.bucketName,
        Key: key,
        Body: processedBuffer,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000', // 1 year cache
      })
    );
    
    const publicUrl = `${R2_CONFIG.publicDomain}/${key}`;
    
    // Calculate compression stats
    const originalSize = file.size;
    const compressedSize = processedBuffer.length;
    const savings = Math.round((1 - compressedSize / originalSize) * 100);
    
    console.log(`[upload-merch-image] Processed: ${width}x${height} → ${IMAGE_SIZE}x${IMAGE_SIZE}, ${(originalSize/1024).toFixed(1)}KB → ${(compressedSize/1024).toFixed(1)}KB (${savings}% smaller)`);
    
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
