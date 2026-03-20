// src/pages/api/update-mix-artwork.ts
// Upload new artwork for a DJ mix to R2

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client } from '../../lib/s3-client';
import { getDocument, updateDocument, verifyRequestUser, invalidateMixesCache } from '../../lib/firebase-rest';
import { processImageToSquareWebP, imageExtension, imageContentType } from '../../lib/image-processing';
import { kvDelete } from '../../lib/kv-cache';
import { ApiErrors, createLogger, getR2Config, successResponse } from '../../lib/api-utils';

const log = createLogger('update-mix-artwork');
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

// Zod schema for text fields from FormData (artwork File validated separately)
const UpdateMixArtworkSchema = z.object({
  mixId: z.string().min(1, 'Mix ID is required').max(300, 'Mix ID too long'),
});

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`update-mix-artwork:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // Initialize for Cloudflare runtime
  const env = locals.runtime.env;

  const R2_CONFIG = getR2Config(env);
  const s3Client = createS3Client(R2_CONFIG);

  try {
    // SECURITY: Verify authentication via token (not cookies/form data which are spoofable)
    const { userId: currentUserId, error: authError } = await verifyRequestUser(request);
    if (!currentUserId || authError) {
      return ApiErrors.unauthorized('Authentication required');
    }

    const formData = await request.formData();

    // Validate text fields via Zod (artwork File validated separately below)
    const parsed = UpdateMixArtworkSchema.safeParse({
      mixId: (formData.get('mixId') as string || '').trim(),
    });
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      return ApiErrors.badRequest(`Invalid field "${firstError.path.join('.')}": ${firstError.message}`);
    }

    const mixId = parsed.data.mixId;
    const artworkFile = formData.get('artwork') as File;

    if (!artworkFile) {
      return ApiErrors.badRequest('Missing artwork file');
    }

    // Get the mix
    const mixData = await getDocument('dj-mixes', mixId);

    if (!mixData) {
      return ApiErrors.notFound('Mix not found');
    }
    
    // Check ownership - allow if:
    // 1. userId matches, OR
    // 2. Mix has no userId (backfill scenario - allow if user ID is passed)
    const isOwner = mixData?.userId === currentUserId;
    const canBackfillOwnership = !mixData?.userId && currentUserId;

    if (!isOwner && !canBackfillOwnership) {
      return ApiErrors.forbidden('Not authorized to edit this mix');
    }
    
    // Validate file size (max 500KB for safety, should be under 200KB from client)
    if (artworkFile.size > 500 * 1024) {
      return ApiErrors.badRequest('Artwork file too large (${Math.round(artworkFile.size / 1024)}KB, max 500KB)');
    }
    
    // Process artwork to WebP and upload to R2
    const timestamp = Date.now();
    const rawBuffer = await artworkFile.arrayBuffer();
    let artworkKey: string;
    let artworkBody: Buffer;
    let artworkContentType: string;

    try {
      const processed = await processImageToSquareWebP(rawBuffer, 800, 80);
      artworkKey = `dj-mixes/${mixId}/artwork-${timestamp}${imageExtension(processed.format)}`;
      artworkBody = Buffer.from(processed.buffer);
      artworkContentType = imageContentType(processed.format);
    } catch (imgErr: unknown) {
      log.error('[update-mix-artwork] WebP processing failed, using original:', imgErr);
      artworkKey = `dj-mixes/${mixId}/artwork-${timestamp}.webp`;
      artworkBody = Buffer.from(rawBuffer);
      artworkContentType = artworkFile.type;
    }

    await s3Client.send(new PutObjectCommand({
      Bucket: R2_CONFIG.bucketName,
      Key: artworkKey,
      Body: artworkBody,
      ContentType: artworkContentType,
      CacheControl: 'public, max-age=31536000',
    }));

    const artworkUrl = `${R2_CONFIG.publicDomain}/${artworkKey}`;

    // Generate 400x400 thumbnail for listing pages
    let thumbUrl: string | undefined;
    try {
      const thumb = await processImageToSquareWebP(rawBuffer, 400, 75);
      const thumbKey = `dj-mixes/${mixId}/thumb${imageExtension(thumb.format)}`;
      await s3Client.send(new PutObjectCommand({
        Bucket: R2_CONFIG.bucketName,
        Key: thumbKey,
        Body: Buffer.from(thumb.buffer),
        ContentType: imageContentType(thumb.format),
        CacheControl: 'public, max-age=31536000',
      }));
      thumbUrl = `${R2_CONFIG.publicDomain}/${thumbKey}`;
    } catch (thumbErr: unknown) {
      log.error('[update-mix-artwork] Thumbnail generation failed (non-critical):', thumbErr);
    }

    // Update Firebase with new artwork URL (and backfill userId if missing)
    const updateData: Record<string, unknown> = {
      artwork_url: artworkUrl,
      artworkUrl: artworkUrl,
      imageUrl: artworkUrl,
      ...(thumbUrl && { thumbUrl }),
      updatedAt: new Date().toISOString()
    };

    // Backfill userId if mix doesn't have one
    if (!mixData?.userId && currentUserId) {
      updateData.userId = currentUserId;
    }

    await updateDocument('dj-mixes', mixId, updateData);

    // Invalidate in-memory and KV caches so all edge workers serve fresh data
    invalidateMixesCache();
    const MIXES_CACHE = { prefix: 'mixes' };
    await kvDelete('public:50', MIXES_CACHE).catch(() => { /* KV cache invalidation — non-critical */ });
    await kvDelete('public:20', MIXES_CACHE).catch(() => { /* KV cache invalidation — non-critical */ });
    await kvDelete('public:100', MIXES_CACHE).catch(() => { /* KV cache invalidation — non-critical */ });

    return successResponse({ artworkUrl,
      message: 'Artwork updated successfully' });
    
  } catch (error: unknown) {
    log.error('[update-mix-artwork] Error:', error);
    return ApiErrors.serverError('Failed to update artwork');
  }
};
