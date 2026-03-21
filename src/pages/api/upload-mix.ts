// src/pages/api/upload-mix.ts
// Uploads DJ mixes to R2 and Firebase with production-ready logging

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client } from '../../lib/s3-client';
import { getDocument, setDocument, verifyRequestUser, invalidateMixesCache } from '../../lib/firebase-rest';
import { d1UpsertMix } from '../../lib/d1-catalog';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { processImageToSquareWebP, imageExtension, imageContentType } from '../../lib/image-processing';
import { invalidateMixesKVCache } from '../../lib/kv-cache';
import { errorResponse, successResponse, ApiErrors, createLogger, getR2Config } from '../../lib/api-utils';
import { logActivity } from '../../lib/activity-feed';
import { scanTracklistForSupport } from '../../lib/dj-support';
import { broadcastActivity } from '../../lib/pusher';

export const prerender = false;

const log = createLogger('upload-mix');


// Helper to format duration for display
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

// Parse tracklist into array - strips leading track numbers for consistent display
function parseTracklist(tracklist: string): string[] {
  if (!tracklist || !tracklist.trim()) return [];
  return tracklist.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      // Remove leading track numbers in formats like: "1.", "01.", "1)", "1:", "1 -", "1-", etc.
      return line.replace(/^\d+[\.\)\:\-]?\s*[-–—]?\s*/, '').trim();
    })
    .filter(line => line.length > 0); // Filter again in case stripping left empty lines
}

// Max total request size for direct upload: 120MB (100MB audio + artwork + form fields)
const MAX_UPLOAD_MIX_REQUEST_SIZE = 120 * 1024 * 1024;

// Zod schema for text fields from FormData (File objects validated separately)
const UploadMixSchema = z.object({
  djName: z.string().max(30, 'DJ name must be 30 characters or less').optional().default(''),
  mixTitle: z.string().min(1, 'Mix title is required').max(50, 'Mix title must be 50 characters or less'),
  mixDescription: z.string().max(300, 'Description must be 300 characters or less').optional().default(''),
  genre: z.string().max(30, 'Genre must be 30 characters or less').optional().default('Jungle'),
  tracklist: z.string().max(1500, 'Tracklist must be 1500 characters or less').optional().default(''),
  durationSeconds: z.string().regex(/^\d+$/, 'Duration must be a number').optional().default('0'),
  userId: z.string().optional().default(''),
});

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: upload operations - 10 per hour
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`upload-mix:${clientId}`, RateLimiters.upload);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // Early Content-Length check to reject oversized requests before reading body into memory
  const contentLength = parseInt(request.headers.get('Content-Length') || '0');
  if (contentLength > MAX_UPLOAD_MIX_REQUEST_SIZE) {
    return errorResponse('Request too large. Maximum 120MB for direct upload. For files over 100MB, use the large file upload option.', 413);
  }

  // Initialize Firebase for Cloudflare runtime
  const env = locals.runtime.env;


  // Initialize R2/S3 client for Cloudflare runtime
  const R2_CONFIG = getR2Config(env);
  const s3Client = createS3Client(R2_CONFIG);

  // Track uploaded R2 keys for cleanup on failure
  const uploadedR2Keys: string[] = [];

  try {
    const formData = await request.formData();

    // Validate text fields via Zod (File objects validated separately below)
    const parsed = UploadMixSchema.safeParse({
      djName: (formData.get('djName') as string || '').trim(),
      mixTitle: (formData.get('mixTitle') as string || '').trim(),
      mixDescription: (formData.get('mixDescription') as string || '').trim(),
      genre: (formData.get('genre') as string || '').trim(),
      tracklist: (formData.get('tracklist') as string || '').trim(),
      durationSeconds: (formData.get('durationSeconds') as string || '0'),
      userId: (formData.get('userId') as string || '').trim(),
    });
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      return ApiErrors.badRequest(`Invalid field "${firstError.path.join('.')}": ${firstError.message}`);
    }

    // Extract validated text fields
    const audioFile = formData.get('audioFile') as File;
    const artworkFile = formData.get('artworkFile') as File | null;
    const djNameFromForm = parsed.data.djName;
    const mixTitle = parsed.data.mixTitle;
    const mixDescription = parsed.data.mixDescription;
    const genre = parsed.data.genre || 'Jungle';
    const tracklistRaw = parsed.data.tracklist;
    const durationSeconds = parseInt(parsed.data.durationSeconds, 10) || 0;
    const userId = parsed.data.userId;

    // Verify the authenticated user matches the claimed userId
    const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
    if (authError || !verifiedUserId) {
      return ApiErrors.unauthorized('Authentication required to upload mixes');
    }
    if (userId && userId !== verifiedUserId) {
      return ApiErrors.forbidden('User ID mismatch - you can only upload mixes for your own account');
    }

    // Validate audio file type
    const allowedAudioTypes = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav'];
    if (audioFile && !allowedAudioTypes.includes(audioFile.type) && !audioFile.name.toLowerCase().match(/\.(mp3|wav)$/)) {
      return ApiErrors.badRequest('Invalid audio format. Only MP3 and WAV files are allowed.');
    }

    // Validate audio file size (100MB max for FormData uploads to avoid Worker memory limits)
    // Files over 100MB should use the large file upload flow via /api/mix/presign-upload/
    const MAX_MIX_SIZE = 100 * 1024 * 1024;
    if (audioFile && audioFile.size > MAX_MIX_SIZE) {
      return ApiErrors.badRequest('Audio file too large for this upload method. Maximum 100MB allowed via direct upload. For files up to 500MB, please use the large file upload option which uploads directly to cloud storage.');
    }

    // Validate artwork file type if provided
    if (artworkFile && artworkFile.size > 0) {
      const allowedImageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
      if (!allowedImageTypes.includes(artworkFile.type)) {
        return ApiErrors.badRequest('Invalid artwork format. Only JPEG, PNG, and WebP are allowed.');
      }
      if (artworkFile.size > 10 * 1024 * 1024) {
        return ApiErrors.badRequest('Artwork too large. Maximum 10MB allowed.');
      }

      // Magic byte validation: verify file content matches claimed MIME type
      const artworkBytes = new Uint8Array(await artworkFile.slice(0, 12).arrayBuffer());
      let magicValid = false;
      if (artworkBytes[0] === 0xFF && artworkBytes[1] === 0xD8 && artworkBytes[2] === 0xFF) {
        magicValid = true; // JPEG
      } else if (artworkBytes[0] === 0x89 && artworkBytes[1] === 0x50 && artworkBytes[2] === 0x4E && artworkBytes[3] === 0x47) {
        magicValid = true; // PNG
      } else if (artworkBytes[0] === 0x52 && artworkBytes[1] === 0x49 && artworkBytes[2] === 0x46 && artworkBytes[3] === 0x46
        && artworkBytes[8] === 0x57 && artworkBytes[9] === 0x45 && artworkBytes[10] === 0x42 && artworkBytes[11] === 0x50) {
        magicValid = true; // WebP (RIFF....WEBP)
      } else if (artworkBytes[0] === 0x47 && artworkBytes[1] === 0x49 && artworkBytes[2] === 0x46 && artworkBytes[3] === 0x38) {
        magicValid = true; // GIF
      }
      if (!magicValid) {
        return ApiErrors.badRequest('Artwork file content does not match its claimed type. Please upload a valid image.');
      }
    }
    
    // Use verified userId (from auth token, not form data)
    const authenticatedUserId = verifiedUserId;

    // Fetch the user's preferred displayName from their profile
    let displayName = djNameFromForm;
    if (authenticatedUserId) {
      try {
        // Check customers collection first (preferred display name)
        let userData = await getDocument('users', authenticatedUserId);
        if (userData?.displayName) {
          displayName = userData.displayName;
          log.info(`[upload-mix] Using displayName from customers: ${displayName}`);
        } else {
          // Fallback to users collection
          userData = await getDocument('users', authenticatedUserId);
          if (userData) {
            displayName = userData.displayName || userData.partnerInfo?.displayName || djNameFromForm;
            log.info(`[upload-mix] Using displayName from users: ${displayName}`);
          }
        }
      } catch (e: unknown) {
        log.info(`[upload-mix] Could not fetch displayName, using form value: ${djNameFromForm}`);
      }
    }
    
    // Use displayName for public display, keep original for reference
    const djName = displayName;

    const tracklistArray = parseTracklist(tracklistRaw);

    // Validate required fields
    if (!audioFile || !djName || !mixTitle || !genre) {
      return ApiErrors.badRequest('Missing required fields (djName, mixTitle, genre, or audioFile)');
    }

    // Generate unique ID and folder structure
    const timestamp = Date.now();
    const sanitizedDjName = djName.replace(/[^a-zA-Z0-9]/g, '_');
    const sanitizedMixTitle = mixTitle.replace(/[^a-zA-Z0-9]/g, '_');
    const mixId = `${sanitizedDjName}_${sanitizedMixTitle}_${timestamp}`;
    const folderPath = `dj-mixes/${mixId}`;

    // Detect audio format - small WAVs are converted client-side, large WAVs upload directly
    const isWav = audioFile.type === 'audio/wav' || audioFile.type === 'audio/x-wav' || audioFile.name.toLowerCase().endsWith('.wav');
    const audioExt = isWav ? 'wav' : 'mp3';
    const audioContentType = isWav ? 'audio/wav' : 'audio/mpeg';

    log.info(`[upload-mix] Uploading: ${djName} - ${mixTitle} (${(audioFile.size / 1024 / 1024).toFixed(2)} MB, ${audioExt.toUpperCase()})`);

    // Upload audio to R2
    const audioBuffer = await audioFile.arrayBuffer();
    const audioKey = `${folderPath}/audio.${audioExt}`;

    await s3Client.send(
      new PutObjectCommand({
        Bucket: R2_CONFIG.bucketName,
        Key: audioKey,
        Body: Buffer.from(audioBuffer),
        ContentType: audioContentType,
        CacheControl: 'public, max-age=31536000',
      })
    );
    uploadedR2Keys.push(audioKey);

    const audioUrl = `${R2_CONFIG.publicDomain}/${audioKey}`;

    // Upload artwork to R2 (or use default)
    let artworkUrl: string;
    let thumbUrl: string | undefined;

    if (artworkFile && artworkFile.size > 0) {
      const artworkBuffer = await artworkFile.arrayBuffer();
      let artworkKey: string;
      let artworkContentType: string;
      let artworkBody: Buffer;

      try {
        // Process artwork + thumbnail in parallel to avoid Worker timeout
        const [processed, thumb] = await Promise.all([
          processImageToSquareWebP(artworkBuffer, 800, 80),
          processImageToSquareWebP(artworkBuffer, 400, 75).catch(() => null),
        ]);

        artworkKey = `${folderPath}/artwork${imageExtension(processed.format)}`;
        artworkContentType = imageContentType(processed.format);
        artworkBody = Buffer.from(processed.buffer);
        log.info(`[upload-mix] Artwork processed to ${processed.width}x${processed.height} ${processed.format}`);

        // Upload artwork + thumbnail in parallel
        const uploads: Promise<unknown>[] = [
          s3Client.send(new PutObjectCommand({
            Bucket: R2_CONFIG.bucketName,
            Key: artworkKey,
            Body: artworkBody,
            ContentType: artworkContentType,
            CacheControl: 'public, max-age=31536000',
          }))
        ];

        let thumbKey: string | undefined;
        if (thumb) {
          thumbKey = `${folderPath}/thumb${imageExtension(thumb.format)}`;
          uploads.push(
            s3Client.send(new PutObjectCommand({
              Bucket: R2_CONFIG.bucketName,
              Key: thumbKey,
              Body: Buffer.from(thumb.buffer),
              ContentType: imageContentType(thumb.format),
              CacheControl: 'public, max-age=31536000',
            }))
          );
        }

        await Promise.all(uploads);
        uploadedR2Keys.push(artworkKey);
        artworkUrl = `${R2_CONFIG.publicDomain}/${artworkKey}`;

        if (thumbKey) {
          uploadedR2Keys.push(thumbKey);
          thumbUrl = `${R2_CONFIG.publicDomain}/${thumbKey}`;
          log.info(`[upload-mix] Thumbnail generated: ${thumb!.width}x${thumb!.height} ${thumb!.format}`);
        }
      } catch (imgErr: unknown) {
        log.error('[upload-mix] WebP processing failed, using original:', imgErr);
        const artworkExt = artworkFile.name.split('.').pop() || 'jpg';
        artworkKey = `${folderPath}/artwork.${artworkExt}`;
        artworkContentType = artworkFile.type;
        artworkBody = Buffer.from(artworkBuffer);

        await s3Client.send(new PutObjectCommand({
          Bucket: R2_CONFIG.bucketName,
          Key: artworkKey,
          Body: artworkBody,
          ContentType: artworkContentType,
          CacheControl: 'public, max-age=31536000',
        }));
        uploadedR2Keys.push(artworkKey);
        artworkUrl = `${R2_CONFIG.publicDomain}/${artworkKey}`;
      }
    } else {
      artworkUrl = '/place-holder.webp';
    }

    // Save to Firebase
    const mixData = {
      id: mixId,
      userId: authenticatedUserId,
      displayName: displayName, // User's preferred display name for public views
      dj_name: djName,
      djName: djName,
      title: mixTitle,
      mixTitle: mixTitle,
      genre: genre,
      description: mixDescription,
      shoutOuts: mixDescription,
      tracklist: tracklistRaw,
      tracklistArray: tracklistArray,
      trackCount: tracklistArray.length,
      durationSeconds: durationSeconds,
      durationFormatted: formatDuration(durationSeconds),
      duration: formatDuration(durationSeconds),
      audio_url: audioUrl,
      audioUrl: audioUrl,
      artwork_url: artworkUrl,
      artworkUrl: artworkUrl,
      ...(thumbUrl && { thumbUrl }),
      upload_date: new Date().toISOString(),
      uploadedAt: new Date().toISOString(),
      folder_path: folderPath,
      r2FolderName: mixId,
      plays: 0,
      downloads: 0,
      likes: 0,
      commentCount: 0,
      ratings: { count: 0, total: 0, average: 0 },
      published: true,
      status: 'live',
      approved: true,
      storage: 'r2',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await setDocument('dj-mixes', mixId, mixData);

    // Dual-write to D1 (non-blocking)
    const db = env?.DB;
    if (db) {
      try {
        await d1UpsertMix(db, mixId, mixData);
        log.info('[upload-mix] Also written to D1');
      } catch (d1Error: unknown) {
        log.error('[upload-mix] D1 dual-write failed (non-critical):', d1Error);
      }
    }

    // Clear in-memory cache so new mix appears immediately
    invalidateMixesCache();

    // Invalidate KV cache for mixes list so all edge workers serve fresh data
    await invalidateMixesKVCache();

    // Log to activity feed (non-blocking)
    if (db) {
      logActivity(db, {
        eventType: 'new_mix',
        actorId: authenticatedUserId,
        actorName: djName || 'Unknown DJ',
        targetId: mixId,
        targetType: 'mix',
        targetName: title,
        targetImage: artworkUrl || undefined,
        targetUrl: `/dj-mix/${mixId}/`,
        metadata: { genre, durationSeconds, trackCount: tracklistArray.length },
      }).catch(() => { /* activity logging non-critical */ });

      // Broadcast real-time update to dashboard widgets (non-blocking)
      broadcastActivity({
        eventType: 'new_mix',
        actorName: djName || 'Unknown DJ',
        targetName: title,
        targetUrl: `/dj-mix/${mixId}/`,
      }, env).catch(() => { /* pusher non-critical */ });

      // Auto-scan tracklist for catalog matches (non-blocking)
      if (tracklistArray.length > 0) {
        scanTracklistForSupport(db, mixId, authenticatedUserId, djName || 'Unknown DJ', tracklistArray)
          .catch(() => { /* tracklist scan non-critical */ });
      }
    }

    log.info(`[upload-mix] Success: ${mixId} (${genre}, ${formatDuration(durationSeconds)}, ${tracklistArray.length} tracks)`);

    return successResponse({ message: 'Mix uploaded and published successfully',
      mixId,
      mix: mixData,
      audioUrl,
      artworkUrl,
      folderName: mixId,
      genre,
      durationSeconds,
      durationFormatted: formatDuration(durationSeconds),
      trackCount: tracklistArray.length });

  } catch (error: unknown) {
    log.error('[upload-mix] Error:', error);

    // Clean up any R2 objects that were uploaded before the failure
    if (uploadedR2Keys.length > 0) {
      try {
        for (const key of uploadedR2Keys) {
          await s3Client.send(new DeleteObjectCommand({
            Bucket: R2_CONFIG.bucketName,
            Key: key,
          }));
          log.info(`[upload-mix] Cleaned up R2 object: ${key}`);
        }
      } catch (cleanupError: unknown) {
        log.error('[upload-mix] R2 cleanup error (original error preserved):', cleanupError);
      }
    }

    return ApiErrors.serverError('Failed to upload mix');
  }
};