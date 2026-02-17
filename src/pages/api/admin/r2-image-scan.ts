// src/pages/api/admin/r2-image-scan.ts
// Scan R2 bucket for problematic images (not WebP, oversized, missing thumbs)
// GET /api/admin/r2-image-scan/?prefix=releases/&cursor=...

import '../../../lib/dom-polyfill';
import type { APIRoute } from 'astro';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { requireAdminAuth } from '../../../lib/admin';
import { createLogger, successResponse, errorResponse, ApiErrors } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

const log = createLogger('r2-image-scan');

const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|bmp|tiff)$/i;
const NON_WEBP = /\.(jpg|jpeg|png|gif|bmp|tiff)$/i;

// Size thresholds by image type (in bytes)
const SIZE_THRESHOLDS: Record<string, number> = {
  'release-cover': 500 * 1024,   // 500KB
  'release-thumb': 200 * 1024,   // 200KB
  'merch': 500 * 1024,           // 500KB
  'vinyl': 800 * 1024,           // 800KB
  'avatar': 100 * 1024,          // 100KB
  'mix-artwork': 500 * 1024,     // 500KB
  'default': 500 * 1024,         // 500KB
};

function getR2Config(env: any) {
  return {
    accountId: env?.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
    bucketName: env?.R2_RELEASES_BUCKET || import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
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

function classifyKey(key: string): string {
  if (key.startsWith('releases/')) {
    if (key.includes('thumb')) return 'release-thumb';
    return 'release-cover';
  }
  if (key.startsWith('merch/')) return 'merch';
  if (key.startsWith('vinyl/')) return 'vinyl';
  if (key.startsWith('avatars/')) return 'avatar';
  if (key.startsWith('dj-mixes/')) return 'mix-artwork';
  return 'default';
}

function getSizeThreshold(key: string): number {
  const type = classifyKey(key);
  return SIZE_THRESHOLDS[type] || SIZE_THRESHOLDS['default'];
}

export const GET: APIRoute = async ({ request, locals }) => {
  const authError = await requireAdminAuth(request, locals);
  if (authError) return authError;

  const rateCheck = checkRateLimit(`r2-scan:${getClientId(request)}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  try {
    const env = locals.runtime.env;
    const r2Config = getR2Config(env);

    if (!r2Config.accessKeyId || !r2Config.secretAccessKey) {
      return ApiErrors.notConfigured('R2');
    }

    const s3Client = createS3Client(r2Config);
    const url = new URL(request.url);
    const prefix = url.searchParams.get('prefix') || '';
    const cursor = url.searchParams.get('cursor') || undefined;
    const maxKeys = Math.min(parseInt(url.searchParams.get('maxKeys') || '1000'), 1000);

    const command = new ListObjectsV2Command({
      Bucket: r2Config.bucketName,
      Prefix: prefix || undefined,
      ContinuationToken: cursor || undefined,
      MaxKeys: maxKeys,
    });

    const response = await s3Client.send(command);
    const objects = response.Contents || [];

    const issues: Array<{ key: string; size: number; issue: string; type: string }> = [];
    const summary = { total: objects.length, notWebp: 0, oversized: 0, missingThumb: 0 };

    // Track release folders to check for missing thumbs
    const releaseFolders = new Map<string, { hasCover: boolean; hasThumb: boolean; hasArtwork: boolean }>();

    for (const obj of objects) {
      const key = obj.Key || '';
      const size = obj.Size || 0;

      // Skip non-image files (audio, zip, etc.)
      if (!IMAGE_EXTENSIONS.test(key)) continue;

      const type = classifyKey(key);

      // Check for non-WebP format
      if (NON_WEBP.test(key)) {
        issues.push({ key, size, issue: 'not-webp', type });
        summary.notWebp++;
      }

      // Check for oversized files
      const threshold = getSizeThreshold(key);
      if (size > threshold) {
        // Avoid duplicate if already flagged as not-webp
        if (!NON_WEBP.test(key)) {
          issues.push({ key, size, issue: 'oversized', type });
        } else {
          // Update the existing issue to note it's also oversized
          const existing = issues.find(i => i.key === key);
          if (existing) existing.issue = 'not-webp,oversized';
        }
        summary.oversized++;
      }

      // Track release folder contents for missing-thumb detection
      if (key.startsWith('releases/')) {
        const parts = key.split('/');
        if (parts.length >= 3) {
          const folder = parts.slice(0, 2).join('/');
          if (!releaseFolders.has(folder)) {
            releaseFolders.set(folder, { hasCover: false, hasThumb: false, hasArtwork: false });
          }
          const info = releaseFolders.get(folder)!;
          const filename = parts[parts.length - 1].toLowerCase();
          if (filename.startsWith('cover')) info.hasCover = true;
          if (filename.startsWith('thumb')) info.hasThumb = true;
          if (filename.startsWith('artwork')) info.hasArtwork = true;
        }
      }
    }

    // Flag release folders missing thumbs
    for (const [folder, info] of releaseFolders) {
      if ((info.hasCover || info.hasArtwork) && !info.hasThumb) {
        issues.push({ key: folder + '/', size: 0, issue: 'missing-thumb', type: 'release-thumb' });
        summary.missingThumb++;
      }
    }

    log.info(`Scanned ${summary.total} objects under "${prefix}", found ${issues.length} issues`);

    return successResponse({
      scanned: summary.total,
      issues,
      cursor: response.NextContinuationToken || null,
      isTruncated: response.IsTruncated || false,
      summary,
    });

  } catch (error: unknown) {
    log.error('Scan failed:', error);
    return errorResponse('Failed to scan R2 bucket', 500);
  }
};
