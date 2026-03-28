// src/pages/api/upload-merch-image.ts
// Upload processed merch images to R2 CDN
// Converts all images to square WebP for consistency
// Uses WASM-based image processing for Cloudflare Workers compatibility

import type { APIRoute } from 'astro';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client } from '../../lib/s3-client';
import { processImageToSquareWebP, processImageToWebP, imageExtension, imageContentType } from '../../lib/image-processing';
import { requireAdminAuth } from '../../lib/admin';
import { createLogger, errorResponse, successResponse, ApiErrors, getR2Config } from '../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

const log = createLogger('[upload-merch-image]');

export const prerender = false;

// Image processing settings
const IMAGE_SIZE = 800; // 800x800 square
const WEBP_QUALITY = 85; // Good balance of quality and size


// Max request size for merch image upload: 50MB
const MAX_MERCH_IMAGE_REQUEST_SIZE = 50 * 1024 * 1024;

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`upload-merch-image:${clientId}`, RateLimiters.upload);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  // Admin authentication required
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  // Early Content-Length check to reject oversized requests before reading body into memory
  const contentLength = parseInt(request.headers.get('Content-Length') || '0');
  if (contentLength > MAX_MERCH_IMAGE_REQUEST_SIZE) {
    return errorResponse('Request too large. Maximum 50MB allowed.', 413);
  }

  const env = locals.runtime.env;
  const r2Config = getR2Config(env);
  const s3Client = createS3Client(r2Config);

  try {
    const formData = await request.formData();

    const file = formData.get('file') as File;
    const folder = (formData.get('folder') as string) || 'merch';
    let filename = (formData.get('filename') as string) || file?.name || 'image.webp';

    if (!file || file.size === 0) {
      return ApiErrors.badRequest('No file provided');
    }

    // Validate file type
    const validTypes = ['image/webp', 'image/png', 'image/jpeg', 'image/jpg', 'image/gif'];
    if (!validTypes.includes(file.type)) {
      return ApiErrors.badRequest('Invalid file type. Only WebP, PNG, JPEG, and GIF are allowed.');
    }

    // Max 10MB input (will be compressed)
    if (file.size > 10 * 1024 * 1024) {
      return ApiErrors.badRequest('File too large. Maximum 10MB allowed.');
    }

    const inputBuffer = await file.arrayBuffer();
    const originalSize = file.size;

    // Check if we should keep the original image dimensions
    const keepOriginal = formData.get('keepOriginal') === 'true';

    let processedBuffer: Uint8Array;
    let dimensions: string;
    let format: string;

    if (keepOriginal) {
      // Convert without cropping - maintains original aspect ratio
      // Use a large max size to effectively not resize (just convert format)
      const processed = await processImageToWebP(inputBuffer, 4096, 4096, WEBP_QUALITY);
      processedBuffer = processed.buffer;
      dimensions = `${processed.width}x${processed.height}`;
      format = processed.format;
    } else {
      // Process image: crop to square, resize to 800x800, convert to optimal format
      const processed = await processImageToSquareWebP(inputBuffer, IMAGE_SIZE, WEBP_QUALITY);
      processedBuffer = processed.buffer;
      dimensions = `${IMAGE_SIZE}x${IMAGE_SIZE}`;
      format = processed.format;
    }

    const compressedSize = processedBuffer.length;

    // Set correct extension based on output format
    filename = filename.replace(/\.[^.]+$/, '') + imageExtension(format);

    // Sanitize folder and filename
    const sanitizedFolder = folder.replace(/[^a-zA-Z0-9-_\/]/g, '-').toLowerCase();
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9-_.]/g, '-').toLowerCase();

    const key = `${sanitizedFolder}/${sanitizedFilename}`;

    await s3Client.send(
      new PutObjectCommand({
        Bucket: r2Config.bucketName,
        Key: key,
        Body: processedBuffer,
        ContentType: imageContentType(format),
        CacheControl: 'public, max-age=31536000, immutable', // 1 year cache, immutable
      })
    );

    const publicUrl = `${r2Config.publicDomain}/${key}`;

    // Calculate compression stats
    const savings = Math.round((1 - compressedSize / originalSize) * 100);

    log.info(`Processed: → ${dimensions} ${format}, ${(originalSize/1024).toFixed(1)}KB → ${(compressedSize/1024).toFixed(1)}KB (${savings}% smaller)`);

    return successResponse({ url: publicUrl,
      key: key,
      size: compressedSize,
      originalSize: originalSize,
      dimensions: dimensions,
      contentType: imageContentType(format),
      savings: `${savings}%` });

  } catch (error: unknown) {
    log.error('Error:', error);

    return ApiErrors.serverError('Failed to process and upload image');
  }
};
