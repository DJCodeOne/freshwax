// src/pages/api/releases/presign-upload.ts
// Generate presigned URLs for SINGLE file uploads to R2
// Used by: ReleaseUploadForm.jsx (partner/pro uploads)
// For BATCH uploads with validation, use: presigned-upload.ts

import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { verifyRequestUser, initFirebaseEnv } from '../../../lib/firebase-rest';
import { getAdminKey } from '../../../lib/api-utils';

export const prerender = false;

function getR2Config(env: any) {
  return {
    accountId: env?.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
    uploadsBucket: env?.R2_UPLOADS_BUCKET || import.meta.env.R2_UPLOADS_BUCKET || 'freshwax-uploads',
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: upload operations - 10 per hour
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`presign-upload:${clientId}`, RateLimiters.upload);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = (locals as any)?.runtime?.env;

  // Initialize Firebase for Cloudflare runtime
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  // Check for admin key first (for admin upload page)
  const adminKey = getAdminKey(request);
  const expectedAdminKey = env?.ADMIN_KEY || import.meta.env.ADMIN_KEY;
  const isAdmin = adminKey && expectedAdminKey && adminKey === expectedAdminKey;

  // If not admin, require authenticated user
  if (!isAdmin) {
    const { userId, error: authError } = await verifyRequestUser(request);
    if (authError || !userId) {
      return new Response(JSON.stringify({
        success: false,
        error: authError || 'Authentication required'
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
  }

  try {
    const { key, contentType, bucket } = await request.json();

    if (!key || !contentType) {
      return new Response(JSON.stringify({ error: 'key and contentType are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const config = getR2Config(env);

    console.log('[Presign] Request bucket param:', bucket);
    console.log('[Presign] Config uploadsBucket:', config.uploadsBucket);

    if (!config.accountId || !config.accessKeyId || !config.secretAccessKey) {
      console.error('[Presign] Missing R2 credentials');
      return new Response(JSON.stringify({ error: 'R2 configuration missing' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Use releases bucket for everything (submissions go to submissions/ folder)
    const bucketName = 'freshwax-releases';

    const s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      ContentType: contentType,
    });

    // Generate presigned URL valid for 1 hour
    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

    console.log(`[Presign] Generated URL for ${bucketName}/${key}`);

    return new Response(JSON.stringify({ uploadUrl, key }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[Presign] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
