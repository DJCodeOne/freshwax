// src/pages/api/releases/presigned-upload.ts
// Generate presigned URLs for direct R2 uploads (bypasses 100MB Worker limit)

import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const prerender = false;

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log('[presigned-upload]', ...args),
  error: (...args: any[]) => console.error('[presigned-upload]', ...args),
};

// Supported file types
const ALLOWED_TYPES: Record<string, string> = {
  // Audio
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/aiff': '.aiff',
  'audio/x-aiff': '.aiff',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  // Images
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  // Archives (for batch uploads)
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
};

function getR2Config(env: any) {
  return {
    accountId: env?.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
    bucketName: env?.R2_RELEASES_BUCKET || import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
    publicDomain: env?.R2_PUBLIC_DOMAIN || import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk',
  };
}

function sanitize(str: string): string {
  return str.replace(/[^a-zA-Z0-9]/g, '').substring(0, 30);
}

function sanitizeFilename(str: string): string {
  return str.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 100);
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any).runtime?.env;
    const r2Config = getR2Config(env);

    if (!r2Config.accountId || !r2Config.accessKeyId || !r2Config.secretAccessKey) {
      log.error('R2 credentials not configured');
      return new Response(JSON.stringify({
        success: false,
        error: 'Storage not configured'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const body = await request.json();
    const {
      files,           // Array of { filename, contentType, size }
      artistName,      // Required for release uploads
      releaseName,     // Required for release uploads
      uploadType = 'release', // 'release', 'mix', 'avatar', 'merch'
      releaseId,       // Optional - reuse existing releaseId
    } = body;

    if (!files || !Array.isArray(files) || files.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'No files specified'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate all file types
    for (const file of files) {
      if (!ALLOWED_TYPES[file.contentType]) {
        return new Response(JSON.stringify({
          success: false,
          error: `Unsupported file type: ${file.contentType}. Supported: MP3, WAV, FLAC, AIFF, M4A, JPG, PNG, WEBP, ZIP`
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Generate or use provided release ID
    const finalReleaseId = releaseId || `${sanitize(artistName || 'upload')}_FW-${Date.now()}`;

    // Create S3 client
    const s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${r2Config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: r2Config.accessKeyId,
        secretAccessKey: r2Config.secretAccessKey,
      },
    });

    // Generate presigned URLs for each file
    const uploadUrls: Array<{
      filename: string;
      uploadUrl: string;
      publicUrl: string;
      key: string;
      contentType: string;
    }> = [];

    for (const file of files) {
      const ext = ALLOWED_TYPES[file.contentType];
      const safeFilename = sanitizeFilename(file.filename.replace(/\.[^.]+$/, '')) + ext;

      // Determine path based on upload type and file type
      let key: string;
      if (file.contentType.startsWith('image/')) {
        key = `releases/${finalReleaseId}/artwork/${safeFilename}`;
      } else if (file.contentType.startsWith('audio/')) {
        key = `releases/${finalReleaseId}/tracks/${safeFilename}`;
      } else if (file.contentType.includes('zip')) {
        key = `releases/${finalReleaseId}/source/${safeFilename}`;
      } else {
        key = `releases/${finalReleaseId}/other/${safeFilename}`;
      }

      const command = new PutObjectCommand({
        Bucket: r2Config.bucketName,
        Key: key,
        ContentType: file.contentType,
      });

      // Generate presigned URL valid for 1 hour
      const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

      uploadUrls.push({
        filename: file.filename,
        uploadUrl,
        publicUrl: `${r2Config.publicDomain}/${key}`,
        key,
        contentType: file.contentType,
      });

      log.info(`Generated presigned URL for: ${key}`);
    }

    return new Response(JSON.stringify({
      success: true,
      releaseId: finalReleaseId,
      uploads: uploadUrls,
      expiresIn: 3600, // 1 hour
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    log.error('Failed to generate presigned URLs:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to generate upload URLs'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
