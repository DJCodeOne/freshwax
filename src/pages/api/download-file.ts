// src/pages/api/download-file.ts
// Stream file directly from R2 via native binding — same-origin, supports progress tracking
// SECURITY: Verifies user owns the order before streaming

import type { APIRoute } from 'astro';
import { verifyRequestUser, getDocument } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { ApiErrors, createLogger } from '../../lib/api-utils';

export const prerender = false;

const log = createLogger('download-file');

// Extract R2 object key from full URL
function extractKeyFromUrl(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    let key: string | null = null;

    if (parsedUrl.hostname === 'cdn.freshwax.co.uk' ||
        parsedUrl.hostname.includes('r2.dev') ||
        parsedUrl.hostname.includes('r2.cloudflarestorage.com')) {
      const path = parsedUrl.pathname.startsWith('/') ? parsedUrl.pathname.slice(1) : parsedUrl.pathname;
      key = decodeURIComponent(path);
    }

    // Reject path traversal
    if (key && (key.includes('..') || key.includes('\0'))) {
      return null;
    }

    return key;
  } catch (_e: unknown) { /* non-critical: malformed URL — return null to signal invalid input */
    return null;
  }
}

// Determine MIME type from file extension
function getMimeType(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'mp3': return 'audio/mpeg';
    case 'wav': return 'audio/wav';
    case 'flac': return 'audio/flac';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'webp': return 'image/webp';
    default: return 'application/octet-stream';
  }
}

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const env = locals.runtime.env;
    const url = new URL(request.url);

    const orderId = url.searchParams.get('orderId');
    const releaseId = url.searchParams.get('releaseId');
    const trackIndexStr = url.searchParams.get('trackIndex');
    const fileType = url.searchParams.get('fileType');
    const filename = url.searchParams.get('filename') || 'download';

    if (!orderId || !releaseId || trackIndexStr === null || !fileType) {
      return ApiErrors.badRequest('Missing required parameters');
    }

    const trackIndex = parseInt(trackIndexStr, 10);
    if (isNaN(trackIndex) || trackIndex < 0) {
      return ApiErrors.badRequest('Invalid trackIndex');
    }

    if (!['mp3', 'wav', 'artwork'].includes(fileType)) {
      return ApiErrors.badRequest('Invalid fileType');
    }

    // Rate limit
    const clientId = getClientId(request);
    const rateLimit = checkRateLimit(`download-file:${clientId}`, RateLimiters.standard);
    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit.retryAfter!);
    }

    // Authenticate
    const { userId, error: authError } = await verifyRequestUser(request);
    if (authError || !userId) {
      return ApiErrors.unauthorized(authError || 'Authentication required');
    }

    // Verify order ownership
    const order = await getDocument('orders', orderId);
    if (!order) {
      log.error('[download-file] Order not found:', orderId);
      return ApiErrors.notFound('Order not found');
    }

    // Check all possible userId field locations
    const customerObj = order.customer as Record<string, unknown> | undefined;
    const orderUserId = customerObj?.userId || order.userId || order.customerId;
    if (orderUserId !== userId) {
      log.error('[download-file] Ownership mismatch:', {
        orderId,
        orderCustomerUserId: customerObj?.userId,
        orderUserId: order.userId,
        orderCustomerId: order.customerId,
        requestingUserId: userId
      });
      return ApiErrors.forbidden('Unauthorized: ownership mismatch');
    }

    if (order.paymentStatus !== 'completed') {
      log.error('[download-file] Payment not completed:', { orderId, status: order.paymentStatus });
      return ApiErrors.forbidden('Payment not yet completed');
    }

    // Find the item
    const item = (order.items || []).find((i: Record<string, unknown>) => {
      const itemReleaseId = i.releaseId || i.productId || i.id;
      return itemReleaseId === releaseId;
    });

    if (!item) {
      return ApiErrors.notFound('Item not found in order');
    }

    // Resolve file URL
    let fileUrl: string | null = null;

    if (fileType === 'artwork') {
      fileUrl = item.downloads?.artworkUrl || null;
    } else {
      const orderTracks = item.downloads?.tracks || [];
      if (orderTracks.length > 0) {
        if (item.type === 'track' && item.trackId) {
          const orderTrack = orderTracks.find((t: Record<string, unknown>) =>
            t.name === item.name || t.trackId === item.trackId
          ) || orderTracks[0];
          if (orderTrack) {
            fileUrl = fileType === 'mp3' ? orderTrack.mp3Url : orderTrack.wavUrl;
          }
        } else {
          if (trackIndex >= orderTracks.length) {
            return ApiErrors.badRequest('Track index out of bounds');
          }
          const orderTrack = orderTracks[trackIndex];
          if (orderTrack) {
            fileUrl = fileType === 'mp3' ? orderTrack.mp3Url : orderTrack.wavUrl;
          }
        }
      }
    }

    // Fallback to release data
    if (!fileUrl) {
      const releaseData = await getDocument('releases', releaseId);
      if (!releaseData) {
        return ApiErrors.notFound('Release not found');
      }

      if (fileType === 'artwork') {
        // Prefer original quality artwork (jpg/png) over processed WebP
        fileUrl = releaseData.originalArtworkUrl || releaseData.coverArtUrl || releaseData.artworkUrl || releaseData.artwork?.cover || null;
      } else {
        const tracks = releaseData.tracks || [];
        if (item.type === 'track' && item.trackId) {
          const track = tracks.find((t: Record<string, unknown>) =>
            t.id === item.trackId || t.trackId === item.trackId || String(t.trackNumber) === String(item.trackId)
          );
          if (track) {
            fileUrl = fileType === 'mp3' ? track.mp3Url : track.wavUrl;
          }
        } else {
          if (trackIndex >= tracks.length) {
            return ApiErrors.badRequest('Track index out of bounds');
          }
          const track = tracks[trackIndex];
          if (track) {
            fileUrl = fileType === 'mp3' ? track.mp3Url : track.wavUrl;
          }
        }
      }
    }

    if (!fileUrl) {
      return ApiErrors.notFound('File not available');
    }

    // Extract R2 key
    const objectKey = extractKeyFromUrl(fileUrl);
    if (!objectKey) {
      // Try stripping known prefixes
      const cdnPrefix = 'https://cdn.freshwax.co.uk/';
      if (fileUrl.startsWith(cdnPrefix)) {
        const key = decodeURIComponent(fileUrl.slice(cdnPrefix.length));
        if (!key.includes('..')) {
          const obj = await env.R2.get(key);
          if (obj) {
            return streamR2Object(obj, filename, key);
          }
        }
      }
      log.error('[download-file] Unrecognized URL:', fileUrl);
      return ApiErrors.badRequest('Invalid file URL');
    }

    // Get from R2 via native binding
    const r2Object = await env.R2.get(objectKey);
    if (!r2Object) {
      log.error('[download-file] R2 object not found:', objectKey);
      return ApiErrors.notFound('File not found in storage');
    }

    return streamR2Object(r2Object, filename, objectKey);

  } catch (error: unknown) {
    log.error('[download-file] Error:', error);
    return ApiErrors.serverError('Download failed');
  }
};

function streamR2Object(r2Object: R2ObjectBody, filename: string, objectKey: string): Response {
  const contentType = getMimeType(objectKey);
  const safeFilename = filename.replace(/["\\\r\n]/g, '_');

  return new Response(r2Object.body, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${safeFilename}"`,
      'Content-Length': String(r2Object.size),
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
