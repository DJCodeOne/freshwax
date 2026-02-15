// src/pages/api/releases/complete-upload.ts
// Called after files are uploaded to R2 - creates Firebase document with status: 'pending'
// Uses Firebase Admin SDK to bypass security rules

import '../../../lib/dom-polyfill'; // Required for AWS SDK XML parsing in Workers
import type { APIRoute } from 'astro';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { processImageToSquareWebP } from '../../../lib/image-processing';
import { getAdminDb } from '../../../lib/firebase-admin';
import { setDocument, getDocument } from '../../../lib/firebase-rest';
import { d1UpsertRelease } from '../../../lib/d1-catalog';

export const prerender = false;

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log('[complete-upload]', ...args),
  error: (...args: any[]) => console.error('[complete-upload]', ...args),
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

/**
 * Process release cover art to WebP: 800x800 cover + 400x400 thumbnail.
 * Returns null if no processing needed (already WebP, empty, or R2 not configured).
 * Falls back to original URL on any failure.
 */
async function processReleaseArtwork(
  coverArtUrl: string,
  env: any,
  logger: typeof log
): Promise<{ coverUrl: string; thumbUrl: string; originalArtworkUrl: string } | null> {
  if (!coverArtUrl || coverArtUrl === '') return null;

  // Skip if already WebP
  const urlLower = coverArtUrl.toLowerCase();
  if (urlLower.endsWith('.webp')) return null;

  // Skip placeholder images
  if (urlLower.includes('placeholder') || urlLower.includes('place-holder')) return null;

  const r2Config = getR2Config(env);
  if (!r2Config.accessKeyId || !r2Config.secretAccessKey) {
    logger.info('R2 not configured, skipping artwork processing');
    return null;
  }

  try {
    // Extract R2 key from CDN URL
    const cdnDomain = r2Config.publicDomain.replace(/\/$/, '');
    let r2Key: string;
    if (coverArtUrl.startsWith(cdnDomain)) {
      r2Key = coverArtUrl.substring(cdnDomain.length + 1); // strip domain + leading /
    } else if (coverArtUrl.startsWith('http')) {
      // External URL — extract path
      const parsed = new URL(coverArtUrl);
      r2Key = parsed.pathname.replace(/^\//, '');
    } else {
      r2Key = coverArtUrl.replace(/^\//, '');
    }

    const s3Client = createS3Client(r2Config);

    // 1. Fetch original image from R2
    const getResponse = await s3Client.send(new GetObjectCommand({
      Bucket: r2Config.bucketName,
      Key: r2Key,
    }));

    if (!getResponse.Body) {
      logger.error('Cover art not found in R2:', r2Key);
      return null;
    }

    const bodyBytes = await getResponse.Body.transformToByteArray();
    logger.info(`Fetched cover art: ${r2Key} (${(bodyBytes.length / 1024).toFixed(1)}KB)`);

    // 2. Process to 800x800 WebP cover
    const coverResult = await processImageToSquareWebP(bodyBytes.buffer as ArrayBuffer, 800, 80);

    // 3. Process to 400x400 WebP thumbnail
    const thumbResult = await processImageToSquareWebP(bodyBytes.buffer as ArrayBuffer, 400, 75);

    // 4. Determine output keys
    const dir = r2Key.substring(0, r2Key.lastIndexOf('/') + 1);
    const coverKey = `${dir}cover.webp`;
    const thumbKey = `${dir}thumb.webp`;

    // 5. Upload both WebP files
    await Promise.all([
      s3Client.send(new PutObjectCommand({
        Bucket: r2Config.bucketName,
        Key: coverKey,
        Body: coverResult.buffer,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000',
      })),
      s3Client.send(new PutObjectCommand({
        Bucket: r2Config.bucketName,
        Key: thumbKey,
        Body: thumbResult.buffer,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000',
      })),
    ]);

    logger.info(`Processed cover: ${coverKey} (${(coverResult.buffer.length / 1024).toFixed(1)}KB)`);
    logger.info(`Processed thumb: ${thumbKey} (${(thumbResult.buffer.length / 1024).toFixed(1)}KB)`);

    // 6. Keep original file for full-res download by buyers
    const originalArtworkUrl = `${cdnDomain}/${r2Key}`;
    logger.info(`Kept original for downloads: ${r2Key}`);

    const coverUrl = `${cdnDomain}/${coverKey}`;
    const thumbUrl = `${cdnDomain}/${thumbKey}`;

    return { coverUrl, thumbUrl, originalArtworkUrl };
  } catch (err) {
    logger.error('Artwork processing failed (using original URL):', err);
    return null;
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any).runtime?.env;

    const body = await request.json();
    const {
      releaseId,
      baseFolder,       // The folder where files were uploaded in R2
      artistName,
      releaseName,
      tracks,           // Array of { title, trackNumber, url, format, fileSize, duration? }
      coverArtUrl,
      uploadedBy,       // User ID who uploaded
      metadata = {},    // Additional metadata (genre, bpm, key, etc.)
    } = body;

    if (!releaseId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'releaseId is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (!artistName || !releaseName) {
      return new Response(JSON.stringify({
        success: false,
        error: 'artistName and releaseName are required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (!tracks || !Array.isArray(tracks) || tracks.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'At least one track is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Check if release already exists (for updates)
    const existingRelease = await getDocument('releases', releaseId);

    // Process cover art to WebP if needed
    const processedArt = await processReleaseArtwork(coverArtUrl, env, log);
    const finalCoverUrl = processedArt?.coverUrl || coverArtUrl || '';
    const finalThumbUrl = processedArt?.thumbUrl || '';
    const finalOriginalArtworkUrl = processedArt?.originalArtworkUrl || coverArtUrl || '';

    // Build track documents with consistent structure
    const processedTracks = tracks.map((track: any, index: number) => ({
      id: `${releaseId}_track_${track.trackNumber || index + 1}`,
      trackNumber: track.trackNumber || index + 1,
      title: track.title || `Track ${index + 1}`,
      artist: artistName,
      artistName: artistName,
      duration: track.duration || 0,
      url: track.url,
      mp3Url: track.format?.toLowerCase() === 'mp3' ? track.url : (track.mp3Url || null),
      wavUrl: track.format?.toLowerCase() === 'wav' ? track.url : (track.wavUrl || null),
      preview_url: track.previewUrl || track.url,
      format: track.format || 'MP3',
      fileSize: track.fileSize || 0,
      bpm: track.bpm || metadata.bpm || null,
      key: track.key || metadata.key || null,
      genre: track.genre || metadata.genre || null,
    }));

    // Determine release type
    const trackCount = processedTracks.length;
    const releaseType = trackCount === 1 ? 'single' : trackCount <= 4 ? 'ep' : 'album';

    // Build release document
    const releaseDoc = {
      id: releaseId,
      artistName,
      releaseName,
      artist: artistName,
      title: releaseName,
      coverArtUrl: finalCoverUrl,
      coverArt: finalCoverUrl,
      thumbUrl: finalThumbUrl,
      originalArtworkUrl: finalOriginalArtworkUrl,
      tracks: processedTracks,
      trackCount,
      status: existingRelease?.status || 'pending',
      approved: existingRelease?.approved || false,
      published: existingRelease?.published || false,
      type: releaseType,
      releaseType,
      uploadedAt: existingRelease?.uploadedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdAt: existingRelease?.createdAt || new Date().toISOString(),
      processedAt: new Date().toISOString(),
      uploadedBy: uploadedBy || existingRelease?.uploadedBy || null,
      submitterId: uploadedBy || existingRelease?.submitterId || existingRelease?.uploadedBy || null,
      // Metadata fields
      catalogNumber: metadata.catalogNumber || existingRelease?.catalogNumber || '',
      genre: metadata.genre || existingRelease?.genre || '',
      bpm: metadata.bpm || existingRelease?.bpm || null,
      key: metadata.key || existingRelease?.key || null,
      releaseDate: metadata.releaseDate || existingRelease?.releaseDate || null,
      description: metadata.description || existingRelease?.description || '',
      // Upload source info
      metadata: {
        ...existingRelease?.metadata,
        ...metadata,
        uploadSource: 'direct-r2-upload',
        lastUploadAt: new Date().toISOString(),
      },
    };

    try {
      // Try Firebase Admin SDK first (bypasses security rules)
      const adminDb = await getAdminDb();

      if (adminDb) {
        log.info('Using Firebase Admin SDK for write...');
        await adminDb.collection('releases').doc(releaseId).set(releaseDoc, { merge: true });
        log.info(`Release document created/updated via Admin SDK: ${releaseId}`);
      } else {
        // Fallback to REST API
        log.info('Admin SDK not available, using REST API...');
        await setDocument('releases', releaseId, releaseDoc);
        log.info(`Release document created/updated via REST API: ${releaseId}`);
      }

      // Dual-write to D1 (secondary, non-blocking)
      const db = env?.DB;
      if (db) {
        try {
          await d1UpsertRelease(db, releaseId, releaseDoc);
          log.info(`Release also written to D1: ${releaseId}`);
        } catch (d1Error) {
          // Log D1 error but don't fail the request
          log.error('D1 dual-write failed (non-critical):', d1Error);
        }
      }
    } catch (setError: any) {
      log.error('Firebase write failed:', setError);
      // Return more detailed error
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to save release data'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({
      success: true,
      releaseId,
      release: releaseDoc,
      message: existingRelease ? 'Release updated successfully' : 'Release created successfully',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    log.error('Failed to complete upload:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to complete upload'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
