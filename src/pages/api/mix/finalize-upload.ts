// src/pages/api/mix/finalize-upload.ts
// Finalizes a DJ mix upload after direct R2 upload completes
// Saves metadata to Firebase

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getDocument, setDocument, verifyRequestUser, invalidateMixesCache } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { fetchWithTimeout, errorResponse, successResponse, ApiErrors, createLogger, getR2Config } from '../../../lib/api-utils';

const log = createLogger('finalize-upload');
import { d1UpsertMix } from '../../../lib/d1-catalog';
import { processImageToSquareWebP, imageExtension, imageContentType } from '../../../lib/image-processing';

const FinalizeUploadSchema = z.object({
  mixId: z.string().min(1).max(500),
  audioUrl: z.string().min(1).max(2000),
  artworkUrl: z.string().max(2000).nullish(),
  folderPath: z.string().max(1000).nullish(),
  djName: z.string().max(200).nullish(),
  mixTitle: z.string().max(500).nullish(),
  mixDescription: z.string().max(5000).nullish(),
  genre: z.string().max(100).nullish(),
  tracklist: z.string().max(10000).nullish(),
  durationSeconds: z.number().min(0).nullish(),
  userId: z.string().max(500).nullish(),
}).passthrough();


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

export const prerender = false;

// Parse tracklist into array
function parseTracklist(tracklist: string): string[] {
  if (!tracklist || !tracklist.trim()) return [];
  return tracklist.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      return line.replace(/^\d+[\.\)\:\-]?\s*[-–—]?\s*/, '').trim();
    })
    .filter(line => line.length > 0);
}

// Max JSON body size for metadata-only requests: 1MB
const MAX_FINALIZE_BODY_SIZE = 1 * 1024 * 1024;

export const POST: APIRoute = async ({ request, locals }) => {
  // Reject oversized JSON bodies before reading into memory
  const reqContentLength = parseInt(request.headers.get('Content-Length') || '0');
  if (reqContentLength > MAX_FINALIZE_BODY_SIZE) {
    return errorResponse('Request body too large. Maximum 1MB for metadata.', 413);
  }

  // Rate limit: upload operations - 10 per hour
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`finalize-mix:${clientId}`, RateLimiters.upload);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;


  // Require authenticated user
  const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
  if (authError || !verifiedUserId) {
    return ApiErrors.unauthorized(authError || 'Authentication required');
  }

  try {
    const rawBody = await request.json();
    const parseResult = FinalizeUploadSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return ApiErrors.badRequest('Invalid request');
    }
    const {
      mixId,
      audioUrl,
      artworkUrl,
      folderPath,
      djName,
      mixTitle,
      mixDescription,
      genre,
      tracklist,
      durationSeconds,
      userId,
    } = parseResult.data;

    // Verify the authenticated user matches the claimed userId
    if (userId && userId !== verifiedUserId) {
      return ApiErrors.forbidden('User ID mismatch - you can only finalize uploads for your own account');
    }

    // CRITICAL: Verify the audio file actually exists in R2 before saving metadata
    // This prevents orphaned mix entries when uploads fail or are cancelled
    try {
      log.info(`[finalize-upload] Verifying audio file exists: ${audioUrl}`);
      const verifyResponse = await fetchWithTimeout(audioUrl, { method: 'HEAD' }, 10000);

      if (!verifyResponse.ok) {
        log.error(`[finalize-upload] Audio file not found: ${audioUrl} (status: ${verifyResponse.status})`);
        return ApiErrors.badRequest('Audio file upload incomplete or failed. Please try uploading again.');
      }

      // Also check file has content (not empty)
      const contentLength = verifyResponse.headers.get('content-length');
      if (!contentLength || parseInt(contentLength) < 1000) {
        log.error(`[finalize-upload] Audio file too small or empty: ${contentLength} bytes`);
        return ApiErrors.badRequest('Audio file appears to be empty or incomplete. Please try uploading again.');
      }

      log.info(`[finalize-upload] Audio file verified: ${contentLength} bytes`);
    } catch (verifyError: unknown) {
      log.error(`[finalize-upload] Failed to verify audio file:`, verifyError);
      return ApiErrors.badRequest('Could not verify audio file. Please try uploading again.');
    }

    // Use verified userId from auth token (not the untrusted body value)
    const authenticatedUserId = verifiedUserId;

    // Get user's display name from profile
    let displayName = djName || 'Unknown DJ';
    if (authenticatedUserId) {
      try {
        const userData = await getDocument('users', authenticatedUserId);
        if (userData?.displayName) {
          displayName = userData.displayName;
        }
      } catch (e: unknown) {
        log.info('[finalize-upload] Could not fetch user data, using provided name');
      }
    }

    const uploadDate = new Date().toISOString();
    const tracklistArray = parseTracklist(tracklist || '');

    // Process artwork to WebP if provided
    let finalArtworkUrl = artworkUrl || '/place-holder.webp';
    let finalThumbUrl: string | undefined;
    if (artworkUrl && !artworkUrl.includes('place-holder')) {
      try {
        const R2_CONFIG = getR2Config(env);
        const s3Client = createS3Client(R2_CONFIG);

        const artworkResp = await fetchWithTimeout(artworkUrl, {}, 15000);
        if (artworkResp.ok) {
          const artworkBuffer = await artworkResp.arrayBuffer();
          const processed = await processImageToSquareWebP(artworkBuffer, 800, 80);
          const artworkKey = `dj-mixes/${mixId}/artwork${imageExtension(processed.format)}`;

          await s3Client.send(new PutObjectCommand({
            Bucket: R2_CONFIG.bucketName,
            Key: artworkKey,
            Body: Buffer.from(processed.buffer),
            ContentType: imageContentType(processed.format),
            CacheControl: 'public, max-age=31536000',
          }));

          finalArtworkUrl = `${R2_CONFIG.publicDomain}/${artworkKey}`;
          log.info(`[finalize-upload] Artwork processed to ${processed.width}x${processed.height} ${processed.format}`);

          // Generate 400x400 thumbnail for listing pages
          try {
            const thumb = await processImageToSquareWebP(artworkBuffer, 400, 75);
            const thumbKey = `dj-mixes/${mixId}/thumb${imageExtension(thumb.format)}`;

            await s3Client.send(new PutObjectCommand({
              Bucket: R2_CONFIG.bucketName,
              Key: thumbKey,
              Body: Buffer.from(thumb.buffer),
              ContentType: imageContentType(thumb.format),
              CacheControl: 'public, max-age=31536000',
            }));

            finalThumbUrl = `${R2_CONFIG.publicDomain}/${thumbKey}`;
            log.info(`[finalize-upload] Thumbnail generated: ${thumb.width}x${thumb.height} ${thumb.format}`);
          } catch (thumbErr: unknown) {
            log.error('[finalize-upload] Thumbnail generation failed (non-critical):', thumbErr);
          }
        }
      } catch (imgErr: unknown) {
        log.error('[finalize-upload] WebP processing failed, using original:', imgErr);
      }
    }

    // Save mix metadata to Firebase
    const mixData = {
      id: mixId,
      title: (mixTitle || 'Untitled Mix').slice(0, 50),
      name: (mixTitle || 'Untitled Mix').slice(0, 50),
      djName: displayName.slice(0, 30),
      dj_name: displayName.slice(0, 30),
      displayName: displayName.slice(0, 30),
      description: (mixDescription || '').slice(0, 150),
      shoutOuts: (mixDescription || '').slice(0, 150),
      genre: (genre || 'Jungle').slice(0, 30),
      tracklist: tracklist || '',
      tracklistArray,
      trackCount: tracklistArray.length,
      durationSeconds: durationSeconds || 0,
      durationFormatted: formatDuration(durationSeconds || 0),
      duration: formatDuration(durationSeconds || 0),
      audio_url: audioUrl,
      audioUrl: audioUrl,
      mp3Url: audioUrl,
      artworkUrl: finalArtworkUrl,
      imageUrl: finalArtworkUrl,
      artwork_url: finalArtworkUrl,
      ...(finalThumbUrl && { thumbUrl: finalThumbUrl }),
      folder_path: folderPath,
      userId: authenticatedUserId,
      upload_date: uploadDate,
      uploadedAt: uploadDate,
      createdAt: uploadDate,
      updatedAt: uploadDate,
      published: true,
      allowDownload: true,
      featured: false,
      plays: 0,
      likes: 0,
      downloads: 0,
      playCount: 0,
      likeCount: 0,
      downloadCount: 0,
      commentCount: 0,
      comments: [],
      ratings: { average: 0, count: 0 },
    };

    // Write to Firebase first (primary)
    await setDocument('dj-mixes', mixId, mixData);
    log.info(`[finalize-upload] Mix saved to Firebase: ${mixId}`);

    // Dual-write to D1 (secondary, non-blocking)
    const db = env?.DB;
    if (db) {
      try {
        await d1UpsertMix(db, mixId, mixData);
        log.info(`[finalize-upload] Mix also written to D1: ${mixId}`);
      } catch (d1Error: unknown) {
        // Log D1 error but don't fail the request
        log.error('[finalize-upload] D1 dual-write failed (non-critical):', d1Error);
      }
    }

    // Clear cache so new mix appears immediately
    invalidateMixesCache();

    return successResponse({ mixId,
      message: 'Mix uploaded successfully' });

  } catch (error: unknown) {
    log.error('[finalize-upload] Error:', error);
    return ApiErrors.serverError('Unknown error');
  }
};

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '0:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
