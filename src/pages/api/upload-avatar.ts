// src/pages/api/upload-avatar.ts
// Upload user avatar to R2 - compressed to small WebP for icon use
// Uses WASM-based image processing for Cloudflare Workers compatibility

import '../../lib/dom-polyfill';
import type { APIRoute } from 'astro';
import { setDocument, initFirebaseEnv } from '../../lib/firebase-rest';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { processImageToSquareWebP } from '../../lib/image-processing';

// Avatar size - small for icon use
const AVATAR_SIZE = 128;

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

// Get R2 configuration from Cloudflare runtime env
function getR2Config(env: any) {
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

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
  initFirebase(locals);

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
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing file or user ID'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate file type
    const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!validTypes.includes(file.type)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid file type. Use JPG, PNG, WebP or GIF.'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate file size (2MB max for upload, will be compressed)
    const maxSize = 2 * 1024 * 1024;
    if (file.size > maxSize) {
      return new Response(JSON.stringify({
        success: false,
        error: 'File too large. Max 2MB.'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Convert file to buffer
    const arrayBuffer = await file.arrayBuffer();
    console.log(`[upload-avatar] Processing file: ${file.name}, type: ${file.type}, size: ${file.size}`);

    // Process image: resize to 128x128 square, convert to WebP
    let processed;
    try {
      processed = await processImageToSquareWebP(arrayBuffer, AVATAR_SIZE, 60);
    } catch (processError) {
      console.error('[upload-avatar] Image processing failed:', processError);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to process image. Try a different image format (JPG or PNG recommended).',
        details: processError instanceof Error ? processError.message : 'Processing error'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const originalSize = file.size;
    const compressedSize = processed.buffer.length;
    console.log(`[upload-avatar] Compressed ${originalSize} -> ${compressedSize} bytes (${Math.round(compressedSize/originalSize*100)}%)`);

    // Always save as WebP now
    const filename = `avatars/${userId}.webp`;

    // Delete any old avatar files with different extensions
    const oldExtensions = ['jpg', 'png', 'gif'];
    for (const ext of oldExtensions) {
      try {
        await r2.send(new DeleteObjectCommand({
          Bucket: r2Config.bucketName,
          Key: `avatars/${userId}.${ext}`,
        }));
      } catch (e) {
        // Ignore - file may not exist
      }
    }

    // Upload compressed WebP to R2
    console.log(`[upload-avatar] Uploading to R2: bucket=${r2Config.bucketName}, key=${filename}`);
    try {
      await r2.send(new PutObjectCommand({
        Bucket: r2Config.bucketName,
        Key: filename,
        Body: processed.buffer,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=86400', // 1 day cache
      }));
      console.log(`[upload-avatar] R2 upload successful`);
    } catch (r2Error) {
      console.error('[upload-avatar] R2 upload failed:', r2Error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to upload to storage',
        details: r2Error instanceof Error ? r2Error.message : 'R2 error'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const avatarUrl = `${r2Config.publicUrl}/${filename}?t=${Date.now()}`;

    // Update customer document with idToken for authentication
    console.log(`[upload-avatar] Updating Firestore for user ${userId}, hasToken: ${!!finalIdToken}`);
    try {
      await setDocument('customers', userId, {
        avatarUrl,
        avatarUpdatedAt: new Date().toISOString()
      }, finalIdToken);
      console.log(`[upload-avatar] Firestore update successful`);
    } catch (firestoreError) {
      console.error('[upload-avatar] Firestore update failed:', firestoreError);
      // Avatar was uploaded to R2, so return partial success
      return new Response(JSON.stringify({
        success: true,
        avatarUrl,
        warning: 'Avatar uploaded but profile update failed. Please try again.',
        originalSize,
        compressedSize: processed.buffer.length
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    console.log(`[upload-avatar] Avatar uploaded for user ${userId}: ${avatarUrl}`);

    return new Response(JSON.stringify({
      success: true,
      avatarUrl,
      originalSize,
      compressedSize
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[upload-avatar] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to upload avatar',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// DELETE: Remove avatar
export const DELETE: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
  initFirebase(locals);

  const r2Config = getR2Config(env);
  const r2 = createR2Client(r2Config);

  // Get idToken from Authorization header
  const authHeader = request.headers.get('Authorization');
  const idToken = authHeader?.replace('Bearer ', '') || undefined;

  try {
    const data = await request.json();
    const { userId } = data;

    if (!userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing user ID'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Delete WebP avatar (and any old formats)
    const extensions = ['webp', 'jpg', 'png', 'gif'];
    for (const ext of extensions) {
      try {
        await r2.send(new DeleteObjectCommand({
          Bucket: r2Config.bucketName,
          Key: `avatars/${userId}.${ext}`,
        }));
      } catch (e) {
        // Ignore errors for non-existent files
      }
    }

    // Remove avatar URL from customer document
    await setDocument('customers', userId, {
      avatarUrl: null,
      avatarUpdatedAt: new Date().toISOString()
    }, idToken);

    console.log(`[upload-avatar] Avatar removed for user ${userId}`);

    return new Response(JSON.stringify({
      success: true
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[upload-avatar] DELETE Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to remove avatar'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
