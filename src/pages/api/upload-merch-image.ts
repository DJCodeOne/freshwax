// src/pages/api/upload-merch-image.ts
// Upload processed merch images to R2 CDN

import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export const prerender = false;

const R2_CONFIG = {
  accountId: import.meta.env.R2_ACCOUNT_ID,
  accessKeyId: import.meta.env.R2_ACCESS_KEY_ID,
  secretAccessKey: import.meta.env.R2_SECRET_ACCESS_KEY,
  bucketName: import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
  publicDomain: import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk',
};

const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_CONFIG.accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_CONFIG.accessKeyId,
    secretAccessKey: R2_CONFIG.secretAccessKey,
  },
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const formData = await request.formData();
    
    const file = formData.get('file') as File;
    const folder = (formData.get('folder') as string) || 'merch';
    const filename = (formData.get('filename') as string) || file?.name || 'image.webp';
    
    if (!file || file.size === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'No file provided'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Validate file type
    const validTypes = ['image/webp', 'image/png', 'image/jpeg', 'image/jpg'];
    if (!validTypes.includes(file.type)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid file type. Only WebP, PNG, and JPEG are allowed.'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Max 5MB
    if (file.size > 5 * 1024 * 1024) {
      return new Response(JSON.stringify({
        success: false,
        error: 'File too large. Maximum 5MB allowed.'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    const buffer = await file.arrayBuffer();
    
    // Sanitize folder and filename
    const sanitizedFolder = folder.replace(/[^a-zA-Z0-9-_\/]/g, '-').toLowerCase();
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9-_.]/g, '-').toLowerCase();
    
    const key = `${sanitizedFolder}/${sanitizedFilename}`;
    
    await s3Client.send(
      new PutObjectCommand({
        Bucket: R2_CONFIG.bucketName,
        Key: key,
        Body: Buffer.from(buffer),
        ContentType: file.type,
        CacheControl: 'public, max-age=31536000', // 1 year cache
      })
    );
    
    const publicUrl = `${R2_CONFIG.publicDomain}/${key}`;
    
    return new Response(JSON.stringify({
      success: true,
      url: publicUrl,
      key: key,
      size: file.size,
      contentType: file.type
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('[upload-merch-image] Error:', error);
    
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to upload image',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
