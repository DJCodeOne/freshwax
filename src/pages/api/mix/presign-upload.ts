// src/pages/api/mix/presign-upload.ts
// Generate presigned URLs for DJ mix uploads (for large files that exceed Worker limits)

import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { verifyRequestUser, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

function getR2Config(env: any) {
  return {
    accountId: env?.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
    bucketName: env?.R2_RELEASES_BUCKET || import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
    publicDomain: env?.R2_PUBLIC_DOMAIN || import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk',
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`mix-presign:${clientId}`, RateLimiters.upload);
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfter!);
  }

  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  // Require authenticated user (all registered users can upload mixes)
  const { userId, error: authError } = await verifyRequestUser(request);
  if (authError || !userId) {
    return new Response(JSON.stringify({
      success: false,
      error: authError || 'Authentication required'
    }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const { fileName, contentType, fileSize, mixId, artworkFileName, artworkContentType } = await request.json();

    if (!fileName || !contentType) {
      return new Response(JSON.stringify({ error: 'fileName and contentType are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const env = (locals as any)?.runtime?.env;
    const config = getR2Config(env);

    if (!config.accountId || !config.accessKeyId || !config.secretAccessKey) {
      console.error('[Mix Presign] Missing R2 credentials');
      return new Response(JSON.stringify({ error: 'R2 configuration missing' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Generate a unique folder path for this mix
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(2, 10);
    const finalMixId = mixId || `mix_${timestamp}_${randomId}`;
    const folderPath = `dj-mixes/${finalMixId}`;

    // Clean filename
    const cleanFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const audioKey = `${folderPath}/${cleanFileName}`;

    const s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });

    const command = new PutObjectCommand({
      Bucket: config.bucketName,
      Key: audioKey,
      ContentType: contentType,
    });

    // Generate presigned URL valid for 2 hours (large files may take time)
    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 7200 });

    // Build the public URL
    const publicUrl = `${config.publicDomain}/${audioKey}`;

    // Generate artwork presigned URL if artwork info provided
    let artworkUploadUrl = null;
    let artworkPublicUrl = null;
    if (artworkFileName && artworkContentType) {
      const artworkExt = artworkFileName.split('.').pop() || 'jpg';
      const artworkKey = `${folderPath}/artwork.${artworkExt}`;

      const artworkCommand = new PutObjectCommand({
        Bucket: config.bucketName,
        Key: artworkKey,
        ContentType: artworkContentType,
      });

      artworkUploadUrl = await getSignedUrl(s3Client, artworkCommand, { expiresIn: 7200 });
      artworkPublicUrl = `${config.publicDomain}/${artworkKey}`;
      console.log(`[Mix Presign] Also generated artwork URL for ${artworkKey}`);
    }

    console.log(`[Mix Presign] Generated URL for ${audioKey} (${(fileSize / 1024 / 1024).toFixed(1)}MB)`);

    return new Response(JSON.stringify({
      success: true,
      uploadUrl,
      key: audioKey,
      publicUrl,
      mixId: finalMixId,
      folderPath,
      artworkUploadUrl,
      artworkPublicUrl
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[Mix Presign] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
