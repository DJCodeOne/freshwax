// src/pages/api/admin/r2-image-scan.ts
// Scan R2 bucket for problematic images (not WebP, oversized, missing thumbs)
// GET /api/admin/r2-image-scan/?prefix=releases/&cursor=...

import type { APIRoute } from 'astro';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createS3Client } from '../../../lib/s3-client';
import { requireAdminAuth } from '../../../lib/admin';
import { createLogger, successResponse, errorResponse, ApiErrors, getR2Config } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

const log = createLogger('r2-image-scan');

const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|bmp|tiff)$/i;
const NON_WEBP = /\.(jpg|jpeg|png|gif|bmp|tiff)$/i;

// Size thresholds by image type (in bytes) — matches 100KB pipeline limit
const SIZE_THRESHOLDS: Record<string, number> = {
  'release-cover': 100 * 1024,   // 100KB
  'release-thumb': 100 * 1024,   // 100KB
  'merch': 100 * 1024,           // 100KB
  'vinyl': 100 * 1024,           // 100KB
  'avatar': 100 * 1024,          // 100KB
  'mix-artwork': 100 * 1024,     // 100KB
  'default': 100 * 1024,         // 100KB
};


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

/**
 * Check if a WebP version of a non-WebP file already exists.
 * Matches the reprocessor naming: artwork.jpg → cover.webp, image.jpg → image.webp
 */
function checkWebpExists(
  key: string,
  allKeys: Set<string>,
  folderContents: Map<string, { webpFiles: string[]; hasThumb: boolean; hasArtwork: boolean; hasCover: boolean }>
): boolean {
  const dir = key.substring(0, key.lastIndexOf('/') + 1);
  const filename = key.substring(key.lastIndexOf('/') + 1);
  const baseName = filename.replace(/\.[^.]+$/, '');
  const baseNameLower = baseName.toLowerCase();

  // Direct match: same name with .webp extension (preserve original case)
  const directWebp = dir + baseName + '.webp';
  if (allKeys.has(directWebp)) return true;

  // For artwork files, the reprocessor outputs cover.webp
  if (baseNameLower.startsWith('artwork')) {
    if (allKeys.has(dir + 'cover.webp')) return true;
  }

  // For release/mix folders, check if a matching webp file exists in the same folder
  const parts = key.split('/');
  if (parts.length >= 3 && (key.startsWith('releases/') || key.startsWith('dj-mixes/'))) {
    const folder = parts.slice(0, 2).join('/');
    const info = folderContents.get(folder);
    if (info && info.webpFiles.length > 0) {
      // Case-insensitive match: cover.webp or same-base-name.webp
      if (info.webpFiles.some(f => f === 'cover.webp' || f.toLowerCase() === baseNameLower + '.webp')) {
        return true;
      }
    }
  }

  return false;
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
    const showAll = url.searchParams.get('showAll') === 'true';

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

    // Build a set of all keys in this page for WebP counterpart detection
    const allKeysInPage = new Set<string>();
    for (const obj of objects) {
      if (obj.Key) allKeysInPage.add(obj.Key);
    }

    // Track release/mix folders for content analysis
    const folderContents = new Map<string, { webpFiles: string[]; hasThumb: boolean; hasArtwork: boolean; hasCover: boolean }>();
    for (const obj of objects) {
      const key = obj.Key || '';
      if (!IMAGE_EXTENSIONS.test(key)) continue;
      const parts = key.split('/');
      if (parts.length >= 3 && (key.startsWith('releases/') || key.startsWith('dj-mixes/'))) {
        const folder = parts.slice(0, 2).join('/');
        if (!folderContents.has(folder)) {
          folderContents.set(folder, { webpFiles: [], hasThumb: false, hasArtwork: false, hasCover: false });
        }
        const info = folderContents.get(folder)!;
        const filename = parts[parts.length - 1].toLowerCase();
        if (filename.endsWith('.webp')) info.webpFiles.push(filename);
        if (filename.startsWith('thumb')) info.hasThumb = true;
        if (filename.startsWith('artwork')) info.hasArtwork = true;
        if (filename.startsWith('cover')) info.hasCover = true;
      }
    }

    for (const obj of objects) {
      const key = obj.Key || '';
      const size = obj.Size || 0;

      // Skip non-image files (audio, zip, etc.)
      if (!IMAGE_EXTENSIONS.test(key)) continue;

      const type = classifyKey(key);

      // Check for non-WebP format
      if (NON_WEBP.test(key)) {
        // Check if a WebP version already exists (skip converted originals)
        const hasWebpVersion = checkWebpExists(key, allKeysInPage, folderContents);
        if (hasWebpVersion) {
          // Already converted — only show in showAll mode
          if (showAll) {
            issues.push({ key, size, issue: 'converted', type });
          }
          continue;
        }

        issues.push({ key, size, issue: 'not-webp', type });
        summary.notWebp++;
      }

      // Check for oversized files (>100KB)
      const threshold = getSizeThreshold(key);
      const isOversize = size > threshold;
      if (isOversize) {
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

      // In showAll mode, include files with no issues too
      if (showAll && !NON_WEBP.test(key) && !isOversize) {
        issues.push({ key, size, issue: 'ok', type });
      }
    }

    // Flag release/mix folders missing thumbs
    for (const [folder, info] of folderContents) {
      if ((info.hasCover || info.hasArtwork) && !info.hasThumb) {
        const type = folder.startsWith('dj-mixes/') ? 'mix-artwork' : 'release-thumb';
        issues.push({ key: folder + '/', size: 0, issue: 'missing-thumb', type });
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
