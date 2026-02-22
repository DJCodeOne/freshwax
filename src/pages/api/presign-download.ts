// src/pages/api/presign-download.ts
// Generate secure, time-limited presigned URLs for purchased downloads
// SECURITY: Verifies user owns the order before generating download URL

import type { APIRoute } from 'astro';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { verifyRequestUser, getDocument } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger, getR2Config, successResponse } from '../../lib/api-utils';
import { z } from 'zod';

const PresignDownloadSchema = z.object({
  orderId: z.string().min(1).max(200),
  releaseId: z.string().max(200),
  trackIndex: z.number().int().min(0).max(999),
  fileType: z.enum(['mp3', 'wav', 'artwork']),
}).passthrough();

export const prerender = false;

const logger = createLogger('presign-download');


// Extract R2 object key from full URL
function extractKeyFromUrl(url: string, publicUrl: string): string | null {
  try {
    const parsedUrl = new URL(url);

    // Handle R2 public URL format (from env)
    let key: string | null = null;
    if (url.startsWith(publicUrl)) {
      key = decodeURIComponent(url.replace(publicUrl + '/', ''));
    } else if (parsedUrl.hostname === 'cdn.freshwax.co.uk') {
      const path = parsedUrl.pathname.startsWith('/') ? parsedUrl.pathname.slice(1) : parsedUrl.pathname;
      key = decodeURIComponent(path);
    } else if (parsedUrl.hostname.includes('r2.dev') || parsedUrl.hostname.includes('r2.cloudflarestorage.com')) {
      const path = parsedUrl.pathname.startsWith('/') ? parsedUrl.pathname.slice(1) : parsedUrl.pathname;
      key = decodeURIComponent(path);
    }

    // Reject path traversal attempts
    if (key && (key.includes('..') || key.includes('\0'))) {
      return null;
    }

    return key;
  } catch {
    return null;
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = locals.runtime.env;

    // Rate limit: download operations - 60 per minute per user
    const clientId = getClientId(request);
    const rateLimit = checkRateLimit(`presign-download:${clientId}`, RateLimiters.standard);
    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit.retryAfter!);
    }

    // SECURITY: Require authentication
    const { userId, error: authError } = await verifyRequestUser(request);
    if (authError || !userId) {
      return ApiErrors.unauthorized(authError || 'Authentication required');
    }
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return ApiErrors.badRequest('Invalid JSON body');
    }

    const parseResult = PresignDownloadSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { orderId, releaseId, trackIndex, fileType } = parseResult.data;

    logger.info('[presign-download] Request:', { orderId, releaseId, trackIndex, fileType, userId });

    // SECURITY: Fetch and verify order ownership
    const order = await getDocument('orders', orderId);

    if (!order) {
      return ApiErrors.notFound('Order not found');
    }

    // Verify user owns this order
    const orderUserId = order.customer?.userId || order.userId || order.customerId;
    if (orderUserId !== userId) {
      logger.error('[presign-download] Unauthorized access attempt:', { orderId, orderUserId, requestingUserId: userId });
      return ApiErrors.forbidden('Unauthorized');
    }

    // SECURITY: Verify payment is completed before allowing download
    if (order.paymentStatus !== 'completed') {
      return ApiErrors.forbidden('Payment not yet completed for this order');
    }

    // Find the item in the order that matches the releaseId
    const item = (order.items || []).find((i: Record<string, unknown>) => {
      const itemReleaseId = i.releaseId || i.productId || i.id;
      return itemReleaseId === releaseId;
    });

    if (!item) {
      return ApiErrors.notFound('Item not found in order');
    }

    // Validate trackIndex is a non-negative integer for non-artwork requests
    if (fileType !== 'artwork') {
      const idx = Number(trackIndex);
      if (!Number.isInteger(idx) || idx < 0) {
        return ApiErrors.badRequest('Invalid trackIndex: must be a non-negative integer');
      }
    }

    // Get the URL to presign
    // First try order's stored download data (locked at purchase time - safer)
    // Then fall back to current release data
    let fileUrl: string | null = null;

    if (fileType === 'artwork') {
      // Try order's stored artwork first
      fileUrl = item.downloads?.artworkUrl || null;
    } else {
      // Try order's stored track URLs first (locked at purchase time)
      const orderTracks = item.downloads?.tracks || [];
      if (orderTracks.length > 0) {
        if (item.type === 'track' && item.trackId) {
          // Single track purchase - find by name or index
          const orderTrack = orderTracks.find((t: Record<string, unknown>) =>
            t.name === item.name || t.trackId === item.trackId
          ) || orderTracks[0];
          if (orderTrack) {
            fileUrl = fileType === 'mp3' ? orderTrack.mp3Url : orderTrack.wavUrl;
          }
        } else {
          // Full release - validate trackIndex bounds
          if (trackIndex >= orderTracks.length) {
            return ApiErrors.badRequest('Track index ${trackIndex} out of bounds (release has ${orderTracks.length} tracks)');
          }
          const orderTrack = orderTracks[trackIndex];
          if (orderTrack) {
            fileUrl = fileType === 'mp3' ? orderTrack.mp3Url : orderTrack.wavUrl;
          }
        }
      }
    }

    // Fall back to current release data if order doesn't have URLs
    if (!fileUrl) {
      logger.info('[presign-download] Order has no stored URL, fetching from release');
      const releaseData = await getDocument('releases', releaseId);

      if (!releaseData) {
        return ApiErrors.notFound('Release not found');
      }

      if (fileType === 'artwork') {
        fileUrl = releaseData.coverArtUrl || releaseData.artworkUrl || releaseData.artwork?.cover || null;
      } else {
        const tracks = releaseData.tracks || [];

        // For single track purchases, match by trackId or name
        if (item.type === 'track' && item.trackId) {
          const track = tracks.find((t: Record<string, unknown>) =>
            t.id === item.trackId ||
            t.trackId === item.trackId ||
            String(t.trackNumber) === String(item.trackId)
          );
          if (track) {
            fileUrl = fileType === 'mp3' ? track.mp3Url : track.wavUrl;
          }
        } else {
          // Validate trackIndex bounds against release tracks
          if (trackIndex >= tracks.length) {
            return ApiErrors.badRequest('Track index ${trackIndex} out of bounds (release has ${tracks.length} tracks)');
          }
          // For full release purchases, use trackIndex
          const track = tracks[trackIndex];
          if (track) {
            fileUrl = fileType === 'mp3' ? track.mp3Url : track.wavUrl;
          }
        }
      }
    }

    if (!fileUrl) {
      logger.error('[presign-download] File URL not found:', { releaseId, trackIndex, fileType });
      return ApiErrors.notFound('${fileType} file not available for this item');
    }

    const config = getR2Config(env);

    // Extract the object key from the URL
    const objectKey = extractKeyFromUrl(fileUrl, config.publicUrl);

    if (!objectKey) {
      // If it's not a recognized R2 URL, reject the request
      logger.error('[presign-download] Unrecognized URL format:', fileUrl);
      return ApiErrors.badRequest('Invalid file URL format');
    }

    // Validate R2 configuration
    if (!config.accountId || !config.accessKeyId || !config.secretAccessKey) {
      logger.error('[presign-download] Missing R2 credentials');
      return ApiErrors.serverError('Server configuration error');
    }

    // Create S3 client for R2
    const s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });

    // Generate presigned URL - valid for 30 minutes
    const expiresIn = 1800; // 30 minutes
    const command = new GetObjectCommand({
      Bucket: 'freshwax-releases',
      Key: objectKey,
    });

    const downloadUrl = await getSignedUrl(s3Client, command, { expiresIn });

    logger.info('[presign-download] Generated presigned URL for:', objectKey);

    return successResponse({ downloadUrl,
      expiresIn });

  } catch (error: unknown) {
    logger.error('[presign-download] Error:', error);
    return ApiErrors.serverError('Failed to generate download URL');
  }
};
