// src/pages/api/vinyl/upload-image.ts
// Upload vinyl listing images to R2 CDN
// Converts all images to WebP for optimal storage

import type { APIRoute } from 'astro';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client } from '../../../lib/s3-client';
import { processImageToWebP, imageExtension, imageContentType } from '../../../lib/image-processing';
import { checkRateLimit, getClientId, rateLimitResponse } from '../../../lib/rate-limit';
import { verifyRequestUser, getDocument } from '../../../lib/firebase-rest';
import { createLogger, ApiErrors, getR2Config, successResponse } from '../../../lib/api-utils';

const log = createLogger('[vinyl-upload-image]');

export const prerender = false;

// Image settings
const MAX_IMAGE_WIDTH = 1200;
const MAX_IMAGE_HEIGHT = 1200;
const WEBP_QUALITY = 85;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB input limit
const MAX_IMAGES_PER_LISTING = 6;


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
    const imageIndex = parseInt(formData.get('imageIndex') as string || '0', 10);

    if (!file || file.size === 0) {
      return ApiErrors.badRequest('No file provided');
    }

    if (!sellerId) {
      return ApiErrors.badRequest('Seller ID required');
    }

    // Verify seller owns this upload
    if (sellerId !== userId) {
      return ApiErrors.forbidden('You can only upload images for your own listings');
    }

    // If listingId is a real listing (not temp), verify ownership
    if (listingId && !listingId.startsWith('temp_')) {
      const listing = await getDocument('vinylListings', listingId);
      if (!listing) {
        return ApiErrors.notFound('Listing not found');
      }
      if (listing.sellerId !== userId) {
        return ApiErrors.forbidden('You can only upload images for your own listings');
      }
    }

    // Validate image index
    if (imageIndex < 0 || imageIndex >= MAX_IMAGES_PER_LISTING) {
      return ApiErrors.badRequest('Image index must be between 0 and ${MAX_IMAGES_PER_LISTING - 1}');
    }

    // Validate file type
    const validTypes = ['image/webp', 'image/png', 'image/jpeg', 'image/jpg', 'image/gif'];
    if (!validTypes.includes(file.type)) {
      return ApiErrors.badRequest('Invalid file type. Only WebP, PNG, JPEG, and GIF are allowed.');
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return ApiErrors.badRequest('File too large. Maximum 10MB allowed.');
    }

    const inputBuffer = await file.arrayBuffer();
    const originalSize = file.size;

    // Process image: resize if needed, convert to WebP
    const processed = await processImageToWebP(inputBuffer, MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT, WEBP_QUALITY);
    const compressedSize = processed.buffer.length;

    // Generate unique filename with correct extension for output format
    const timestamp = Date.now();
    const filename = `${listingId}_${imageIndex}_${timestamp}${imageExtension(processed.format)}`;
    const key = `vinyl/${sellerId}/${filename}`;

    await s3Client.send(
      new PutObjectCommand({
        Bucket: r2Config.bucketName,
        Key: key,
        Body: processed.buffer,
        ContentType: imageContentType(processed.format),
        CacheControl: 'public, max-age=31536000',
      })
    );

    const publicUrl = `${r2Config.publicDomain}/${key}`;
    const savings = Math.round((1 - compressedSize / originalSize) * 100);

    log.info(`Processed: ${(originalSize/1024).toFixed(1)}KB → ${(compressedSize/1024).toFixed(1)}KB (${savings}% smaller)`);

    return successResponse({ url: publicUrl,
      key,
      size: compressedSize,
      originalSize,
      dimensions: `${processed.width}x${processed.height}`,
      savings: `${savings}%`,
      imageIndex });

  } catch (error: unknown) {
    log.error('Error:', error);
    return ApiErrors.serverError('Failed to process and upload image');
  }
};
