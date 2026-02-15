// src/pages/api/admin/r2-image-reprocess.ts
// Batch reprocess R2 images: fetch, convert to WebP, re-upload
// POST /api/admin/r2-image-reprocess/

import '../../../lib/dom-polyfill';
import type { APIRoute } from 'astro';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { processImageToSquareWebP, processImageToWebP } from '../../../lib/image-processing';
import { requireAdminAuth } from '../../../lib/admin';
import { createLogger, successResponse, errorResponse, ApiErrors, parseJsonBody } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

const log = createLogger('r2-image-reprocess');

const MAX_BATCH_SIZE = 10;

interface ReprocessRequest {
  keys: string[];
  deleteOriginals?: boolean;
}

interface ReprocessResult {
  key: string;
  status: 'success' | 'failed' | 'skipped';
  oldSize?: number;
  newSize?: number;
  newKey?: string;
  thumbCreated?: boolean;
  thumbKey?: string;
  thumbSize?: number;
  error?: string;
  urlChanges?: Array<{ oldKey: string; newKey: string }>;
}

// Image processing config by key type
interface ProcessingConfig {
  mode: 'square' | 'aspect';
  width: number;
  height: number;
  quality: number;
}

function getR2Config(env: any) {
  return {
    accountId: env?.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
    bucketName: env?.R2_RELEASES_BUCKET || import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
    publicDomain: env?.R2_PUBLIC_DOMAIN || import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk',
  };
}

function createS3Client(config: ReturnType<typeof getR2Config>) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

function getProcessingConfig(key: string): { cover: ProcessingConfig; thumb?: ProcessingConfig } {
  if (key.startsWith('releases/')) {
    const filename = key.split('/').pop()?.toLowerCase() || '';
    if (filename.startsWith('thumb')) {
      return { cover: { mode: 'square', width: 400, height: 400, quality: 75 } };
    }
    // For cover or artwork, generate both cover + thumb
    return {
      cover: { mode: 'square', width: 800, height: 800, quality: 80 },
      thumb: { mode: 'square', width: 400, height: 400, quality: 75 },
    };
  }
  if (key.startsWith('merch/')) {
    return { cover: { mode: 'square', width: 800, height: 800, quality: 85 } };
  }
  if (key.startsWith('vinyl/')) {
    return { cover: { mode: 'aspect', width: 1200, height: 1200, quality: 85 } };
  }
  if (key.startsWith('avatars/')) {
    return { cover: { mode: 'square', width: 128, height: 128, quality: 60 } };
  }
  if (key.startsWith('dj-mixes/')) {
    const filename = key.split('/').pop()?.toLowerCase() || '';
    if (filename.startsWith('thumb')) {
      return { cover: { mode: 'square', width: 400, height: 400, quality: 75 } };
    }
    // For artwork images, generate both cover + thumb (same as releases)
    return {
      cover: { mode: 'square', width: 800, height: 800, quality: 80 },
      thumb: { mode: 'square', width: 400, height: 400, quality: 75 },
    };
  }
  // Default
  return { cover: { mode: 'square', width: 800, height: 800, quality: 80 } };
}

function getWebPKey(originalKey: string, suffix?: string): string {
  const dir = originalKey.substring(0, originalKey.lastIndexOf('/') + 1);
  const filename = originalKey.substring(originalKey.lastIndexOf('/') + 1);
  const baseName = filename.replace(/\.[^.]+$/, '');

  if (suffix) {
    return `${dir}${suffix}.webp`;
  }

  // For artwork files, output as cover.webp
  if (baseName.toLowerCase().startsWith('artwork')) {
    return `${dir}cover.webp`;
  }

  return `${dir}${baseName}.webp`;
}

async function processImage(
  inputBuffer: ArrayBuffer,
  config: ProcessingConfig,
): Promise<Uint8Array> {
  if (config.mode === 'square') {
    const result = await processImageToSquareWebP(inputBuffer, config.width, config.quality);
    return result.buffer;
  } else {
    const result = await processImageToWebP(inputBuffer, config.width, config.height, config.quality);
    return result.buffer;
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  const body = await parseJsonBody<ReprocessRequest>(request);
  if (!body) return ApiErrors.badRequest('Invalid JSON body');

  const authError = await requireAdminAuth(request, locals, body);
  if (authError) return authError;

  const rateCheck = checkRateLimit(`r2-reprocess:${getClientId(request)}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const { keys, deleteOriginals = false } = body;

  if (!Array.isArray(keys) || keys.length === 0) {
    return ApiErrors.badRequest('keys must be a non-empty array');
  }
  if (keys.length > MAX_BATCH_SIZE) {
    return ApiErrors.badRequest(`Maximum ${MAX_BATCH_SIZE} keys per batch`);
  }

  // Validate keys don't contain path traversal
  for (const key of keys) {
    if (key.includes('..') || key.startsWith('/')) {
      return ApiErrors.badRequest(`Invalid key: ${key}`);
    }
  }

  try {
    const env = (locals as any)?.runtime?.env;
    const r2Config = getR2Config(env);

    if (!r2Config.accessKeyId || !r2Config.secretAccessKey) {
      return ApiErrors.notConfigured('R2');
    }

    const s3Client = createS3Client(r2Config);
    const results: ReprocessResult[] = [];
    let processed = 0;
    let failed = 0;

    for (const key of keys) {
      try {
        // 1. Fetch image from R2
        const getCommand = new GetObjectCommand({
          Bucket: r2Config.bucketName,
          Key: key,
        });

        const getResponse = await s3Client.send(getCommand);
        if (!getResponse.Body) {
          results.push({ key, status: 'failed', error: 'Object not found or empty' });
          failed++;
          continue;
        }

        const bodyBytes = await getResponse.Body.transformToByteArray();
        const oldSize = bodyBytes.length;

        // 2. Determine processing config
        const config = getProcessingConfig(key);
        const result: ReprocessResult = { key, status: 'success', oldSize, urlChanges: [] };

        // 3. Process cover/main image
        const coverBuffer = await processImage(bodyBytes.buffer as ArrayBuffer, config.cover);
        const coverKey = getWebPKey(key);
        result.newSize = coverBuffer.length;
        result.newKey = coverKey;

        // Upload processed cover
        await s3Client.send(new PutObjectCommand({
          Bucket: r2Config.bucketName,
          Key: coverKey,
          Body: coverBuffer,
          ContentType: 'image/webp',
          CacheControl: 'public, max-age=31536000',
        }));

        if (coverKey !== key) {
          result.urlChanges!.push({ oldKey: key, newKey: coverKey });
        }

        log.info(`Processed ${key} → ${coverKey}: ${(oldSize / 1024).toFixed(1)}KB → ${(coverBuffer.length / 1024).toFixed(1)}KB`);

        // 4. Generate thumb if configured (releases)
        if (config.thumb) {
          const thumbBuffer = await processImage(bodyBytes.buffer as ArrayBuffer, config.thumb);
          const dir = key.substring(0, key.lastIndexOf('/') + 1);
          const thumbKey = `${dir}thumb.webp`;

          await s3Client.send(new PutObjectCommand({
            Bucket: r2Config.bucketName,
            Key: thumbKey,
            Body: thumbBuffer,
            ContentType: 'image/webp',
            CacheControl: 'public, max-age=31536000',
          }));

          result.thumbCreated = true;
          result.thumbKey = thumbKey;
          result.thumbSize = thumbBuffer.length;
          log.info(`Generated thumb ${thumbKey}: ${(thumbBuffer.length / 1024).toFixed(1)}KB`);
        }

        // 5. Delete original if it was non-WebP and we created a new file at a different key
        if (deleteOriginals && coverKey !== key) {
          await s3Client.send(new DeleteObjectCommand({
            Bucket: r2Config.bucketName,
            Key: key,
          }));
          log.info(`Deleted original: ${key}`);
        }

        results.push(result);
        processed++;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        log.error(`Failed to process ${key}:`, err);
        results.push({ key, status: 'failed', error: message });
        failed++;
      }
    }

    return successResponse({
      processed,
      failed,
      results,
    });

  } catch (error) {
    log.error('Reprocess batch failed:', error);
    return errorResponse('Failed to reprocess images', 500);
  }
};
