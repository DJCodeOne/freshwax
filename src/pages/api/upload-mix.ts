// src/pages/api/upload-mix.ts
// Uploads DJ mixes to R2 and Firebase with production-ready logging

import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getDocument, setDocument, verifyRequestUser, invalidateMixesCache } from '../../lib/firebase-rest';
import { d1UpsertMix } from '../../lib/d1-catalog';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { processImageToSquareWebP, imageExtension, imageContentType } from '../../lib/image-processing';
import { kvDelete } from '../../lib/kv-cache';
import { errorResponse, ApiErrors, createLogger } from '../../lib/api-utils';

export const prerender = false;

const logger = createLogger('upload-mix');

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

// Create S3 client with runtime env
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

    // Get all form fields with character limits
    const audioFile = formData.get('audioFile') as File;
    const artworkFile = formData.get('artworkFile') as File | null;
    const djNameFromForm = (formData.get('djName') as string || '').trim().slice(0, 30);
    const mixTitle = (formData.get('mixTitle') as string || '').trim().slice(0, 50);
    const mixDescription = (formData.get('mixDescription') as string || '').trim().slice(0, 150);
    const genre = (formData.get('genre') as string || 'Jungle').trim().slice(0, 30);
    const tracklistRaw = (formData.get('tracklist') as string || '').trim().slice(0, 1500);
    const durationSeconds = parseInt(formData.get('durationSeconds') as string || '0', 10) || 0;
    const userId = (formData.get('userId') as string || '').trim();

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
          logger.info(`[upload-mix] Using displayName from customers: ${displayName}`);
        } else {
          // Fallback to users collection
          userData = await getDocument('users', authenticatedUserId);
          if (userData) {
            displayName = userData.displayName || userData.partnerInfo?.displayName || djNameFromForm;
            logger.info(`[upload-mix] Using displayName from users: ${displayName}`);
          }
        }
      } catch (e) {
        logger.info(`[upload-mix] Could not fetch displayName, using form value: ${djNameFromForm}`);
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

    logger.info(`[upload-mix] Uploading: ${djName} - ${mixTitle} (${(audioFile.size / 1024 / 1024).toFixed(2)} MB, ${audioExt.toUpperCase()})`);

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
        const processed = await processImageToSquareWebP(artworkBuffer, 800, 80);
        artworkKey = `${folderPath}/artwork${imageExtension(processed.format)}`;
        artworkContentType = imageContentType(processed.format);
        artworkBody = Buffer.from(processed.buffer);
        logger.info(`[upload-mix] Artwork processed to ${processed.width}x${processed.height} ${processed.format}`);
      } catch (imgErr) {
        logger.error('[upload-mix] WebP processing failed, using original:', imgErr);
        const artworkExt = artworkFile.name.split('.').pop() || 'jpg';
        artworkKey = `${folderPath}/artwork.${artworkExt}`;
        artworkContentType = artworkFile.type;
        artworkBody = Buffer.from(artworkBuffer);
      }

      await s3Client.send(
        new PutObjectCommand({
          Bucket: R2_CONFIG.bucketName,
          Key: artworkKey,
          Body: artworkBody,
          ContentType: artworkContentType,
          CacheControl: 'public, max-age=31536000',
        })
      );
      uploadedR2Keys.push(artworkKey);

      artworkUrl = `${R2_CONFIG.publicDomain}/${artworkKey}`;

      // Generate 400x400 thumbnail for listing pages
      try {
        const thumb = await processImageToSquareWebP(artworkBuffer, 400, 75);
        const thumbKey = `${folderPath}/thumb${imageExtension(thumb.format)}`;
        await s3Client.send(
          new PutObjectCommand({
            Bucket: R2_CONFIG.bucketName,
            Key: thumbKey,
            Body: Buffer.from(thumb.buffer),
            ContentType: imageContentType(thumb.format),
            CacheControl: 'public, max-age=31536000',
          })
        );
        uploadedR2Keys.push(thumbKey);
        thumbUrl = `${R2_CONFIG.publicDomain}/${thumbKey}`;
        logger.info(`[upload-mix] Thumbnail generated: ${thumb.width}x${thumb.height} ${thumb.format}`);
      } catch (thumbErr) {
        logger.error('[upload-mix] Thumbnail generation failed (non-critical):', thumbErr);
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
        logger.info('[upload-mix] Also written to D1');
      } catch (d1Error) {
        logger.error('[upload-mix] D1 dual-write failed (non-critical):', d1Error);
      }
    }

    // Clear in-memory cache so new mix appears immediately
    invalidateMixesCache();

    // Invalidate KV cache for mixes list so all edge workers serve fresh data
    const MIXES_CACHE = { prefix: 'mixes' };
    await kvDelete('public:50', MIXES_CACHE).catch(() => {});
    await kvDelete('public:20', MIXES_CACHE).catch(() => {});
    await kvDelete('public:100', MIXES_CACHE).catch(() => {});

    logger.info(`[upload-mix] Success: ${mixId} (${genre}, ${formatDuration(durationSeconds)}, ${tracklistArray.length} tracks)`);

    return new Response(JSON.stringify({
      success: true,
      message: 'Mix uploaded and published successfully',
      mixId,
      mix: mixData,
      audioUrl,
      artworkUrl,
      folderName: mixId,
      genre,
      durationSeconds,
      durationFormatted: formatDuration(durationSeconds),
      trackCount: tracklistArray.length
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    logger.error('[upload-mix] Error:', error);

    // Clean up any R2 objects that were uploaded before the failure
    if (uploadedR2Keys.length > 0) {
      try {
        for (const key of uploadedR2Keys) {
          await s3Client.send(new DeleteObjectCommand({
            Bucket: R2_CONFIG.bucketName,
            Key: key,
          }));
          logger.info(`[upload-mix] Cleaned up R2 object: ${key}`);
        }
      } catch (cleanupError) {
        logger.error('[upload-mix] R2 cleanup error (original error preserved):', cleanupError);
      }
    }

    return ApiErrors.serverError('Failed to upload mix');
  }
};