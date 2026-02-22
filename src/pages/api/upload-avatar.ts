// src/pages/api/upload-avatar.ts
// Upload user avatar to R2 - compressed to small WebP for icon use
// Uses WASM-based image processing for Cloudflare Workers compatibility

import '../../lib/dom-polyfill';
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { setDocument } from '../../lib/firebase-rest';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { processImageToSquareWebP, imageExtension, imageContentType } from '../../lib/image-processing';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { errorResponse, ApiErrors, createLogger } from '../../lib/api-utils';

const log = createLogger('upload-avatar');

const DeleteAvatarSchema = z.object({
  userId: z.string().min(1, 'Missing user ID').max(200),
});

// Avatar size - small for icon use
const AVATAR_SIZE = 128;



// Get R2 configuration from Cloudflare runtime env
function getR2Config(env: Record<string, unknown>) {
  return {
    accountId: env?.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY || '',
    bucketName: env?.R2_RELEASES_BUCKET || import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
    publicUrl: env?.R2_PUBLIC_URL || import.meta.env.R2_PUBLIC_URL || 'https://pub-5c0458d0721c4946884a203f2ca66ee0.r2.dev',
  };
}

// Create S3 client with runtime env
function createR2Client(config: ReturnType<typeof getR2Config>) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

// Max request size for avatar upload: 10MB (2MB file limit + form overhead)
const MAX_AVATAR_REQUEST_SIZE = 10 * 1024 * 1024;

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: upload operations - 10 per hour
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`upload-avatar:${clientId}`, RateLimiters.upload);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // Early Content-Length check to reject oversized requests before reading body into memory
  const contentLength = parseInt(request.headers.get('Content-Length') || '0');
  if (contentLength > MAX_AVATAR_REQUEST_SIZE) {
    return errorResponse('Request too large. Maximum avatar file size is 2MB.', 413);
  }

  const env = locals.runtime.env;

  const r2Config = getR2Config(env);
  const r2 = createR2Client(r2Config);

  // Get idToken from Authorization header
  const authHeader = request.headers.get('Authorization');
  const idToken = authHeader?.replace('Bearer ', '') || undefined;

  try {
    const formData = await request.formData();
    const file = formData.get('avatar') as File;
    const userId = formData.get('userId') as string;
    // Also check for idToken in form data as fallback
    const formIdToken = formData.get('idToken') as string;
    const finalIdToken = idToken || formIdToken || undefined;

    if (!file || !userId) {
      return ApiErrors.badRequest('Missing file or user ID');
    }

    // SECURITY: Verify the requesting user owns this userId
    const { verifyUserToken } = await import('../../lib/firebase-rest');
    if (!finalIdToken) {
      return ApiErrors.unauthorized('Authentication required');
    }
    const tokenUserId = await verifyUserToken(finalIdToken);
    if (!tokenUserId || tokenUserId !== userId) {
      return ApiErrors.forbidden('You can only upload your own avatar');
    }

    // Validate file type
    const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!validTypes.includes(file.type)) {
      return ApiErrors.badRequest('Invalid file type. Use JPG, PNG, WebP or GIF.');
    }

    // Validate file size (2MB max for upload, will be compressed)
    const maxSize = 2 * 1024 * 1024;
    if (file.size > maxSize) {
      return ApiErrors.badRequest('File too large. Max 2MB.');
    }

    // Convert file to buffer
    const arrayBuffer = await file.arrayBuffer();

    // Process image: resize to 128x128 square, convert to WebP
    let processed;
    try {
      processed = await processImageToSquareWebP(arrayBuffer, AVATAR_SIZE, 60);
    } catch (processError: unknown) {
      log.error('[upload-avatar] Image processing failed:', processError);
      return ApiErrors.serverError('Failed to process image. Try a different image format (JPG or PNG recommended).');
    }

    const originalSize = file.size;
    const compressedSize = processed.buffer.length;

    // Save with format-appropriate extension
    const filename = `avatars/${userId}${imageExtension(processed.format)}`;

    // Delete any old avatar files with different extensions
    const oldExtensions = ['webp', 'jpg', 'png', 'gif'];
    for (const ext of oldExtensions) {
      try {
        await r2.send(new DeleteObjectCommand({
          Bucket: r2Config.bucketName,
          Key: `avatars/${userId}.${ext}`,
        }));
      } catch (e: unknown) {
        // Ignore - file may not exist
      }
    }

    // Upload compressed image to R2
    try {
      await r2.send(new PutObjectCommand({
        Bucket: r2Config.bucketName,
        Key: filename,
        Body: processed.buffer,
        ContentType: imageContentType(processed.format),
        CacheControl: 'public, max-age=3600', // 1 hour cache (mutable - avatar can be re-uploaded)
      }));
    } catch (r2Error: unknown) {
      log.error('[upload-avatar] R2 upload failed:', r2Error);
      return ApiErrors.serverError('Failed to upload to storage');
    }

    const avatarUrl = `${r2Config.publicUrl}/${filename}?t=${Date.now()}`;

    // Update customer document with idToken for authentication
    try {
      await setDocument('users', userId, {
        avatarUrl,
        avatarUpdatedAt: new Date().toISOString()
      }, finalIdToken);
    } catch (firestoreError: unknown) {
      log.error('[upload-avatar] Firestore update failed:', firestoreError);
      // Avatar was uploaded to R2, so return partial success
      return new Response(JSON.stringify({
        success: true,
        avatarUrl,
        warning: 'Avatar uploaded but profile update failed. Please try again.',
        originalSize,
        compressedSize: processed.buffer.length
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({
      success: true,
      avatarUrl,
      originalSize,
      compressedSize
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    log.error('[upload-avatar] Error:', error);
    return ApiErrors.serverError('Failed to upload avatar');
  }
};

// DELETE: Remove avatar
export const DELETE: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;

  const r2Config = getR2Config(env);
  const r2 = createR2Client(r2Config);

  // Get idToken from Authorization header
  const authHeader = request.headers.get('Authorization');
  const idToken = authHeader?.replace('Bearer ', '') || undefined;

  try {
    const data = await request.json();
    const parsed = DeleteAvatarSchema.safeParse(data);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const { userId } = parsed.data;

    // SECURITY: Verify the requesting user owns this userId
    const { verifyUserToken } = await import('../../lib/firebase-rest');
    if (!idToken) {
      return ApiErrors.unauthorized('Authentication required');
    }
    const tokenUserId = await verifyUserToken(idToken);
    if (!tokenUserId || tokenUserId !== userId) {
      return ApiErrors.forbidden('You can only delete your own avatar');
    }

    // Delete WebP avatar (and any old formats)
    const extensions = ['webp', 'jpg', 'png', 'gif'];
    for (const ext of extensions) {
      try {
        await r2.send(new DeleteObjectCommand({
          Bucket: r2Config.bucketName,
          Key: `avatars/${userId}.${ext}`,
        }));
      } catch (e: unknown) {
        // Ignore errors for non-existent files
      }
    }

    // Remove avatar URL from customer document
    await setDocument('users', userId, {
      avatarUrl: null,
      avatarUpdatedAt: new Date().toISOString()
    }, idToken);

    return new Response(JSON.stringify({
      success: true
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    log.error('[upload-avatar] DELETE Error:', error);
    return ApiErrors.serverError('Failed to remove avatar');
  }
};
