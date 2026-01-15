// src/pages/api/presign-download.ts
// Generate secure, time-limited presigned URLs for purchased downloads
// SECURITY: Verifies user owns the order before generating download URL

import type { APIRoute } from 'astro';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { verifyRequestUser, initFirebaseEnv, queryCollection, getDocument } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

export const prerender = false;

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

function getR2Config(env: any) {
  return {
    accountId: env?.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
    publicUrl: env?.R2_PUBLIC_URL || import.meta.env.R2_PUBLIC_URL || 'https://pub-5c0458d0721c4946884a203f2ca66ee0.r2.dev',
  };
}

// Extract R2 object key from full URL
function extractKeyFromUrl(url: string, publicUrl: string): string | null {
  try {
    const parsedUrl = new URL(url);

    // Handle R2 public URL format (from env)
    if (url.startsWith(publicUrl)) {
      const key = url.replace(publicUrl + '/', '');
      // Decode URI components to get the actual R2 object key
      return decodeURIComponent(key);
    }

    // Handle cdn.freshwax.co.uk (custom domain pointing to R2)
    if (parsedUrl.hostname === 'cdn.freshwax.co.uk') {
      const path = parsedUrl.pathname.startsWith('/') ? parsedUrl.pathname.slice(1) : parsedUrl.pathname;
      return decodeURIComponent(path);
    }

    // Handle R2 dev URLs
    if (parsedUrl.hostname.includes('r2.dev') || parsedUrl.hostname.includes('r2.cloudflarestorage.com')) {
      const path = parsedUrl.pathname.startsWith('/') ? parsedUrl.pathname.slice(1) : parsedUrl.pathname;
      return decodeURIComponent(path);
    }

    return null;
  } catch {
    return null;
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any)?.runtime?.env;

    // Rate limit: download operations - 60 per minute per user
    const clientId = getClientId(request);
    const rateLimit = checkRateLimit(`presign-download:${clientId}`, RateLimiters.standard);
    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit.retryAfter!);
    }

    // Initialize Firebase for Cloudflare runtime
    initFirebaseEnv({
      FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
      FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
    });

    // SECURITY: Require authentication
    const { userId, error: authError } = await verifyRequestUser(request);
    if (authError || !userId) {
      return new Response(JSON.stringify({
        success: false,
        error: authError || 'Authentication required'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const body = await request.json();
    const { orderId, releaseId, trackIndex, fileType } = body;

    // Validate required fields
    if (!orderId || releaseId === undefined || trackIndex === undefined || !fileType) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required fields: orderId, releaseId, trackIndex, fileType'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!['mp3', 'wav', 'artwork'].includes(fileType)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid fileType. Must be mp3, wav, or artwork'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    log.info('[presign-download] Request:', { orderId, releaseId, trackIndex, fileType, userId });

    // SECURITY: Fetch and verify order ownership
    const allOrders = await queryCollection('orders', { limit: 200, skipCache: true });
    const order = allOrders.find((o: any) => o.id === orderId);

    if (!order) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Order not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Verify user owns this order
    const orderUserId = order.customer?.userId || order.userId || order.customerId;
    if (orderUserId !== userId) {
      log.error('[presign-download] Unauthorized access attempt:', { orderId, orderUserId, requestingUserId: userId });
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized'
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Find the item in the order that matches the releaseId
    const item = (order.items || []).find((i: any) => {
      const itemReleaseId = i.releaseId || i.productId || i.id;
      return itemReleaseId === releaseId;
    });

    if (!item) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Item not found in order'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Fetch the release to get the actual file URLs
    // (URLs are stored in releases collection, not in orders)
    const releaseData = await getDocument('releases', releaseId);

    if (!releaseData) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Release not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get the URL to presign
    let fileUrl: string | null = null;

    if (fileType === 'artwork') {
      fileUrl = releaseData.coverArtUrl || releaseData.artworkUrl || releaseData.artwork?.cover || null;
    } else {
      const tracks = releaseData.tracks || [];

      // For single track purchases, match by trackId or name
      if (item.type === 'track' && item.trackId) {
        const track = tracks.find((t: any) =>
          t.id === item.trackId ||
          t.trackId === item.trackId ||
          String(t.trackNumber) === String(item.trackId)
        );
        if (track) {
          fileUrl = fileType === 'mp3' ? track.mp3Url : track.wavUrl;
        }
      } else {
        // For full release purchases, use trackIndex
        const track = tracks[trackIndex];
        if (track) {
          fileUrl = fileType === 'mp3' ? track.mp3Url : track.wavUrl;
        }
      }
    }

    if (!fileUrl) {
      log.error('[presign-download] File URL not found:', { releaseId, trackIndex, fileType, tracksCount: releaseData.tracks?.length });
      return new Response(JSON.stringify({
        success: false,
        error: `${fileType} file not available for this item`
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const config = getR2Config(env);

    // Extract the object key from the URL
    const objectKey = extractKeyFromUrl(fileUrl, config.publicUrl);

    if (!objectKey) {
      // If it's not a recognized R2 URL, reject the request
      log.error('[presign-download] Unrecognized URL format:', fileUrl);
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid file URL format'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate R2 configuration
    if (!config.accountId || !config.accessKeyId || !config.secretAccessKey) {
      log.error('[presign-download] Missing R2 credentials');
      return new Response(JSON.stringify({
        success: false,
        error: 'Server configuration error'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
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

    log.info('[presign-download] Generated presigned URL for:', objectKey);

    return new Response(JSON.stringify({
      success: true,
      downloadUrl,
      expiresIn
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    log.error('[presign-download] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to generate download URL',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
