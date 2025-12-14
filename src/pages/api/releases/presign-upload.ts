// src/pages/api/releases/presign-upload.ts
// Generate presigned URLs for uploading to R2 uploads bucket

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const prerender = false;

function getR2Config(env: any) {
  return {
    accountId: env?.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
    uploadsBucket: env?.R2_UPLOADS_BUCKET || import.meta.env.R2_UPLOADS_BUCKET || 'freshwax-uploads',
  };
}

export async function POST({ request, locals }: { request: Request; locals: any }) {
  try {
    const { key, contentType, bucket } = await request.json();

    if (!key || !contentType) {
      return new Response(JSON.stringify({ error: 'key and contentType are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const env = locals?.runtime?.env;
    const config = getR2Config(env);

    if (!config.accountId || !config.accessKeyId || !config.secretAccessKey) {
      console.error('[Presign] Missing R2 credentials');
      return new Response(JSON.stringify({ error: 'R2 configuration missing' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Use uploads bucket for partner submissions
    const bucketName = bucket === 'uploads' ? config.uploadsBucket : 'freshwax-releases';

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
}
