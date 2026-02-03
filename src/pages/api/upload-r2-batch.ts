// src/pages/api/upload-r2-batch.ts
// Simple R2 upload endpoint for zip uploader - uploads individual files to R2

import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export const prerender = false;

// Get R2 configuration from Cloudflare runtime env
function getR2Config(env: any) {
  return {
    accountId: env?.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
    bucketName: env?.R2_RELEASES_BUCKET || import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
    publicDomain: env?.R2_PUBLIC_DOMAIN || import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk',
  };
}

function getContentType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop();
  const types: Record<string, string> = {
    'webp': 'image/webp',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'flac': 'audio/flac',
    'json': 'application/json',
  };
  return types[ext || ''] || 'application/octet-stream';
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any)?.runtime?.env || {};
    const R2_CONFIG = getR2Config(env);

    // Validate R2 config
    if (!R2_CONFIG.accountId || !R2_CONFIG.accessKeyId || !R2_CONFIG.secretAccessKey) {
      return new Response(JSON.stringify({
        success: false,
        error: 'R2 configuration missing'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File;
    const filename = formData.get('filename') as string;
    const releaseId = formData.get('releaseId') as string;
    const fileType = formData.get('fileType') as string; // metadata, track, preview, artwork

    if (!file || !releaseId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing file or releaseId'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Create S3 client for R2
    const s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_CONFIG.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_CONFIG.accessKeyId,
        secretAccessKey: R2_CONFIG.secretAccessKey,
      },
    });

    // Determine the key/path in R2
    let subFolder = 'files';
    if (fileType === 'metadata') subFolder = 'metadata';
    else if (fileType === 'track') subFolder = 'tracks';
    else if (fileType === 'preview') subFolder = 'previews';
    else if (fileType === 'artwork') subFolder = 'artwork';

    const key = `releases/${releaseId}/${subFolder}/${filename || file.name}`;
    const contentType = getContentType(filename || file.name);

    // Get file content
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Upload to R2
    const command = new PutObjectCommand({
      Bucket: R2_CONFIG.bucketName,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000',
    });

    await s3Client.send(command);

    const publicUrl = `${R2_CONFIG.publicDomain}/${key}`;

    return new Response(JSON.stringify({
      success: true,
      url: publicUrl,
      key: key,
      size: buffer.length,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[upload-r2-batch] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Upload failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
