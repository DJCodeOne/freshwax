// src/pages/api/admin/migrate-legacy-images.ts
// Scan Firebase collections for non-WebP image URLs, convert to WebP (<100KB), update Firebase + D1
// POST /api/admin/migrate-legacy-images/
//
// Releases: preserves original URL in `originalArtworkUrl` for buyer hi-res downloads
// DJ Mixes / Merch: just WebP for display, no original preservation needed

import '../../../lib/dom-polyfill';
import type { APIRoute } from 'astro';
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { processImageToSquareWebP, imageExtension, imageContentType } from '../../../lib/image-processing';
import { requireAdminAuth } from '../../../lib/admin';
import { initFirebaseEnv, queryCollection, getDocument, updateDocument } from '../../../lib/firebase-rest';
import { d1UpsertRelease, d1UpsertMix, d1UpsertMerch } from '../../../lib/d1-catalog';
import { createLogger, successResponse, errorResponse, ApiErrors, parseJsonBody } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

const log = createLogger('migrate-legacy-images');

const MAX_BATCH_SIZE = 50;
const MAX_FILE_SIZE = 100 * 1024; // 100KB target

const VALID_COLLECTIONS = ['releases', 'dj-mixes', 'merch'] as const;
type CollectionName = typeof VALID_COLLECTIONS[number];

interface MigrateRequest {
  collection: CollectionName;
  dryRun?: boolean;
  limit?: number;
}

interface MigrateDetail {
  docId: string;
  fields: string[];
  status: 'migrated' | 'already_webp' | 'failed' | 'skipped';
  savings?: string;
  error?: string;
}

// Processing config per collection
const PROCESSING_CONFIG: Record<CollectionName, {
  width: number;
  quality: number;
  thumb?: { width: number; quality: number };
}> = {
  'releases': { width: 800, quality: 80, thumb: { width: 400, quality: 75 } },
  'dj-mixes': { width: 800, quality: 80, thumb: { width: 400, quality: 75 } },
  'merch': { width: 800, quality: 85 },
};

// Image URL fields to check per collection
const IMAGE_FIELDS: Record<CollectionName, string[]> = {
  'releases': ['coverUrl', 'coverArtUrl', 'artworkUrl', 'thumbUrl', 'imageUrl'],
  'dj-mixes': ['artworkUrl', 'artwork_url', 'imageUrl', 'coverUrl', 'thumbUrl'],
  'merch': ['imageUrl'],
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

/** Extract R2 key from a CDN URL. */
function extractR2Key(url: string, publicDomain: string): string | null {
  const domain = publicDomain.replace(/\/+$/, '');
  if (!url.startsWith(domain + '/')) return null;
  const key = url.slice(domain.length + 1);
  if (key.includes('..') || key.startsWith('/')) return null;
  return key;
}

/** Build output key from original R2 key. Normalizes artwork -> cover. Uses format-aware extension. */
function getOutputKey(originalKey: string, format: string = 'webp'): string {
  const ext = imageExtension(format);
  const dir = originalKey.substring(0, originalKey.lastIndexOf('/') + 1);
  const filename = originalKey.substring(originalKey.lastIndexOf('/') + 1);
  const baseName = filename.replace(/\.[^.]+$/, '');
  if (baseName.toLowerCase().startsWith('artwork')) {
    return `${dir}cover${ext}`;
  }
  return `${dir}${baseName}${ext}`;
}

/** Check if URL points to an already-optimized image (WebP or JPEG from our pipeline). */
function isOptimizedImage(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.endsWith('.webp') || lower.endsWith('.jpg') || lower.endsWith('.jpeg');
}

async function r2ObjectExists(s3: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert image to the smallest format (WebP or JPEG), reducing quality iteratively until output is under MAX_FILE_SIZE.
 * Returns the buffer, final size, quality, and chosen format.
 */
async function convertImageUnder100KB(
  inputBuffer: ArrayBuffer,
  width: number,
  startQuality: number,
): Promise<{ buffer: Uint8Array; size: number; quality: number; format: string }> {
  let quality = startQuality;
  const MIN_QUALITY = 40;

  while (quality >= MIN_QUALITY) {
    const result = await processImageToSquareWebP(inputBuffer, width, quality);
    if (result.buffer.length <= MAX_FILE_SIZE || quality <= MIN_QUALITY) {
      return { buffer: result.buffer, size: result.buffer.length, quality, format: result.format };
    }
    // Reduce quality by 10 and try again
    quality -= 10;
    log.info(`Output ${(result.buffer.length / 1024).toFixed(0)}KB > 100KB, retrying at quality ${quality}`);
  }

  // Final attempt at minimum quality (should always be reached by the loop, but just in case)
  const result = await processImageToSquareWebP(inputBuffer, width, MIN_QUALITY);
  return { buffer: result.buffer, size: result.buffer.length, quality: MIN_QUALITY, format: result.format };
}

/** Extract all non-WebP image URLs from a document. */
function extractNonWebPUrls(doc: any, collection: CollectionName): Map<string, string> {
  const result = new Map<string, string>();
  const fields = IMAGE_FIELDS[collection];

  for (const field of fields) {
    const value = doc[field];
    if (typeof value === 'string' && value.startsWith('http') && !isOptimizedImage(value)) {
      result.set(field, value);
    }
  }

  // Handle merch images[] array
  if (collection === 'merch' && Array.isArray(doc.images)) {
    for (let i = 0; i < doc.images.length; i++) {
      const img = doc.images[i];
      const url = typeof img === 'string' ? img : (img?.url || null);
      if (url && typeof url === 'string' && url.startsWith('http') && !isOptimizedImage(url)) {
        result.set(`images[${i}]`, url);
      }
    }
  }

  return result;
}

/**
 * Find the best original cover URL from a document to preserve for buyer downloads.
 * Returns the first non-WebP cover/artwork URL found.
 */
function findOriginalCoverUrl(doc: any): string | null {
  for (const field of ['coverUrl', 'coverArtUrl', 'artworkUrl', 'imageUrl']) {
    const value = doc[field];
    if (typeof value === 'string' && value.startsWith('http') && !isOptimizedImage(value)) {
      return value;
    }
  }
  return null;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const body = await parseJsonBody<MigrateRequest>(request);
  if (!body) return ApiErrors.badRequest('Invalid JSON body');

  const authError = await requireAdminAuth(request, locals, body);
  if (authError) return authError;

  const rateCheck = checkRateLimit(`migrate-images:${getClientId(request)}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  const { collection, dryRun = true, limit = 50 } = body;

  if (!VALID_COLLECTIONS.includes(collection)) {
    return ApiErrors.badRequest(`Invalid collection: ${collection}. Must be one of: ${VALID_COLLECTIONS.join(', ')}`);
  }

  const effectiveLimit = Math.min(limit, MAX_BATCH_SIZE);
  const env = locals.runtime.env;

  initFirebaseEnv({
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL: env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY: env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY,
  });

  const r2Config = getR2Config(env);
  if (!r2Config.accessKeyId || !r2Config.secretAccessKey) {
    return ApiErrors.notConfigured('R2');
  }

  const s3Client = createS3Client(r2Config);
  const processingConfig = PROCESSING_CONFIG[collection];

  try {
    const docs = await queryCollection(collection, { skipCache: true }, true);

    const total = docs.length;
    let scanned = 0;
    let migrated = 0;
    let alreadyWebp = 0;
    let failed = 0;
    const details: MigrateDetail[] = [];

    const docsToProcess = docs.slice(0, effectiveLimit);

    for (const doc of docsToProcess) {
      scanned++;
      const docId = doc.id;

      try {
        const nonWebPUrls = extractNonWebPUrls(doc, collection);

        if (nonWebPUrls.size === 0) {
          alreadyWebp++;
          continue;
        }

        if (dryRun) {
          details.push({
            docId,
            fields: Array.from(nonWebPUrls.keys()),
            status: 'migrated',
            savings: `${nonWebPUrls.size} field(s) to convert`,
          });
          migrated++;
          continue;
        }

        // ---- LIVE MIGRATION ----
        const fieldUpdates: Record<string, any> = {};
        let totalOldSize = 0;
        let totalNewSize = 0;
        const migratedFields: string[] = [];

        // For releases: preserve original hi-res cover URL for buyer downloads
        // The order creation code already checks originalArtworkUrl first
        if (collection === 'releases' && !doc.originalArtworkUrl) {
          const originalUrl = findOriginalCoverUrl(doc);
          if (originalUrl) {
            fieldUpdates.originalArtworkUrl = originalUrl;
            log.info(`Preserving original artwork for ${docId}: ${originalUrl}`);
          }
        }

        // We may need the original bytes for multiple conversions (cover + thumb),
        // so cache fetched buffers by R2 key
        const fetchedBuffers = new Map<string, Uint8Array>();

        for (const [fieldName, url] of nonWebPUrls) {
          const r2Key = extractR2Key(url, r2Config.publicDomain);
          if (!r2Key) {
            log.warn(`Could not extract R2 key from URL: ${url} (doc: ${docId})`);
            continue;
          }

          // First check if a WebP version already exists (backward compat)
          const legacyWebPKey = getOutputKey(r2Key, 'webp');
          const webpExists = await r2ObjectExists(s3Client, r2Config.bucketName, legacyWebPKey);

          let outputKey: string;
          let outputUrl: string;

          if (!webpExists) {
            try {
              // Fetch original (or use cached buffer)
              let bodyBytes = fetchedBuffers.get(r2Key);
              if (!bodyBytes) {
                const getResponse = await s3Client.send(new GetObjectCommand({
                  Bucket: r2Config.bucketName,
                  Key: r2Key,
                }));
                if (!getResponse.Body) {
                  log.warn(`Empty body for R2 key: ${r2Key}`);
                  continue;
                }
                bodyBytes = await getResponse.Body.transformToByteArray();
                fetchedBuffers.set(r2Key, bodyBytes);
              }

              totalOldSize += bodyBytes.length;

              const isThumb = fieldName.toLowerCase().includes('thumb');
              const config = isThumb && processingConfig.thumb
                ? processingConfig.thumb
                : processingConfig;

              const converted = await convertImageUnder100KB(
                bodyBytes.buffer as ArrayBuffer,
                config.width,
                config.quality,
              );

              totalNewSize += converted.size;

              outputKey = getOutputKey(r2Key, converted.format);
              outputUrl = `${r2Config.publicDomain}/${outputKey}`;

              await s3Client.send(new PutObjectCommand({
                Bucket: r2Config.bucketName,
                Key: outputKey,
                Body: converted.buffer,
                ContentType: imageContentType(converted.format),
                CacheControl: 'public, max-age=31536000, immutable',
              }));

              log.info(`Converted ${r2Key} -> ${outputKey}: ${(bodyBytes.length / 1024).toFixed(1)}KB -> ${(converted.size / 1024).toFixed(1)}KB (q${converted.quality}, ${converted.format})`);
            } catch (err: unknown) {
              log.error(`Failed to convert ${r2Key}:`, err);
              continue;
            }
          } else {
            outputKey = legacyWebPKey;
            outputUrl = `${r2Config.publicDomain}/${legacyWebPKey}`;
            log.info(`WebP already exists on R2: ${legacyWebPKey}`);
          }

          // Collect field update
          if (fieldName.startsWith('images[')) {
            const idxMatch = fieldName.match(/\[(\d+)\]/);
            if (idxMatch) {
              if (!fieldUpdates._imagesArrayUpdates) {
                fieldUpdates._imagesArrayUpdates = [];
              }
              fieldUpdates._imagesArrayUpdates.push({
                index: parseInt(idxMatch[1], 10),
                newUrl: outputUrl,
              });
            }
          } else {
            fieldUpdates[fieldName] = outputUrl;
          }

          migratedFields.push(fieldName);
        }

        // Generate thumb for releases/dj-mixes if not already handled
        if (processingConfig.thumb && !migratedFields.some(f => f.toLowerCase().includes('thumb'))) {
          // Find a cover-type field that was migrated to get its directory
          const coverField = migratedFields.find(f =>
            ['coverUrl', 'coverArtUrl', 'artworkUrl', 'imageUrl'].includes(f)
          );
          if (coverField && fieldUpdates[coverField]) {
            const coverOutputKey = extractR2Key(fieldUpdates[coverField], r2Config.publicDomain);
            if (coverOutputKey) {
              // Find the original source bytes for this cover
              const originalUrl = nonWebPUrls.get(coverField);
              const origR2Key = originalUrl ? extractR2Key(originalUrl, r2Config.publicDomain) : null;
              const sourceBytes = origR2Key ? fetchedBuffers.get(origR2Key) : null;

              // Process thumb to determine format, then build the key
              let thumbKey: string | null = null;
              let thumbUrl: string | null = null;

              if (sourceBytes) {
                try {
                  const thumbConverted = await convertImageUnder100KB(
                    sourceBytes.buffer as ArrayBuffer,
                    processingConfig.thumb.width,
                    processingConfig.thumb.quality,
                  );
                  const dir = coverOutputKey.substring(0, coverOutputKey.lastIndexOf('/') + 1);
                  thumbKey = `${dir}thumb${imageExtension(thumbConverted.format)}`;
                  thumbUrl = `${r2Config.publicDomain}/${thumbKey}`;

                  const thumbExists = await r2ObjectExists(s3Client, r2Config.bucketName, thumbKey);
                  if (!thumbExists) {
                    await s3Client.send(new PutObjectCommand({
                      Bucket: r2Config.bucketName,
                      Key: thumbKey,
                      Body: thumbConverted.buffer,
                      ContentType: imageContentType(thumbConverted.format),
                      CacheControl: 'public, max-age=31536000, immutable',
                    }));
                    log.info(`Generated thumb: ${thumbKey} (${(thumbConverted.size / 1024).toFixed(1)}KB, ${thumbConverted.format})`);
                  }
                } catch (err: unknown) {
                  log.warn(`Failed to generate thumb for ${docId}:`, err);
                }
              } else {
                // No source bytes; check if a legacy webp thumb already exists
                const dir = coverOutputKey.substring(0, coverOutputKey.lastIndexOf('/') + 1);
                thumbKey = `${dir}thumb.webp`;
                thumbUrl = `${r2Config.publicDomain}/${thumbKey}`;
              }

              // Update thumbUrl field
              if (thumbUrl && (doc.thumbUrl !== undefined || collection === 'releases')) {
                fieldUpdates.thumbUrl = thumbUrl;
                migratedFields.push('thumbUrl');
              }
            }
          }
        }

        // Apply images[] array updates for merch
        if (fieldUpdates._imagesArrayUpdates && Array.isArray(doc.images)) {
          const updatedImages = [...doc.images];
          for (const update of fieldUpdates._imagesArrayUpdates) {
            const img = updatedImages[update.index];
            if (typeof img === 'string') {
              updatedImages[update.index] = update.newUrl;
            } else if (typeof img === 'object' && img !== null && img.url) {
              updatedImages[update.index] = { ...img, url: update.newUrl };
            }
          }
          fieldUpdates.images = updatedImages;
        }
        delete fieldUpdates._imagesArrayUpdates;

        if (migratedFields.length === 0) {
          alreadyWebp++;
          continue;
        }

        // Update Firebase
        await updateDocument(collection, docId, fieldUpdates);
        log.info(`Updated Firebase ${collection}/${docId}: ${migratedFields.join(', ')}`);

        // Sync to D1
        const db = env?.DB;
        if (db) {
          try {
            const updatedDoc = await getDocument(collection, docId);
            if (updatedDoc) {
              let d1Success = false;
              if (collection === 'releases') {
                d1Success = await d1UpsertRelease(db, docId, updatedDoc);
              } else if (collection === 'dj-mixes') {
                d1Success = await d1UpsertMix(db, docId, updatedDoc);
              } else if (collection === 'merch') {
                d1Success = await d1UpsertMerch(db, docId, updatedDoc);
              }
              if (d1Success) {
                log.info(`D1 synced: ${collection}/${docId}`);
              } else {
                log.warn(`D1 upsert returned false for ${collection}/${docId}`);
              }
            }
          } catch (err: unknown) {
            log.error(`D1 sync failed for ${collection}/${docId}:`, err);
          }
        }

        migrated++;
        const savings = totalOldSize > 0 && totalNewSize > 0
          ? `${(totalOldSize / 1024).toFixed(0)}KB -> ${(totalNewSize / 1024).toFixed(0)}KB (${Math.round((1 - totalNewSize / totalOldSize) * 100)}%)`
          : 'used existing WebP';

        details.push({
          docId,
          fields: migratedFields,
          status: 'migrated',
          savings,
        });

      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        log.error(`Failed to migrate ${docId}:`, err);
        failed++;
        details.push({
          docId,
          fields: [],
          status: 'failed',
          error: message,
        });
      }
    }

    return successResponse({
      collection,
      dryRun,
      total,
      scanned,
      migrated,
      alreadyWebp,
      failed,
      details,
    });

  } catch (err: unknown) {
    log.error('Migration batch failed:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return errorResponse(`Migration failed: ${message}`, 500);
  }
};
