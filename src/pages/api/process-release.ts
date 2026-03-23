// src/pages/api/process-release.ts
// Process a release submission from R2 - creates Firebase entry
// Copies files from submissions/ to releases/ folder for organization

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { saSetDocument, saQueryCollection } from '../../lib/firebase-service-account';
import { getAdminFirebaseContext } from '../../lib/firebase/admin-context';
import { invalidateReleasesCache, clearCache } from '../../lib/firebase-rest';
import { createLogger, errorResponse, successResponse, ApiErrors } from '../../lib/api-utils';
import { requireAdminAuth } from '../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import { invalidateReleasesKVCache } from '../../lib/kv-cache';
import type { Track } from '../../lib/types';
import { processReleaseArtwork } from '../../lib/release/artwork';
import { buildTrackArray } from '../../lib/release/track-builder';

const processReleaseSchema = z.object({
  submissionId: z.string().min(1, 'submissionId is required'),
  adminKey: z.string().optional(),
}).strip();

const log = createLogger('process-release');

// Create a clean folder name from artist and release name
function createReleaseFolderName(artistName: string, releaseName: string): string {
  const cleanArtist = artistName.toLowerCase().replace(/[^a-z0-9]+/g, '_').substring(0, 30);
  const cleanRelease = releaseName.toLowerCase().replace(/[^a-z0-9]+/g, '_').substring(0, 30);
  const timestamp = Date.now();
  return `${cleanArtist}_${cleanRelease}_${timestamp}`;
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    // Parse body first to get adminKey for auth
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch (e: unknown) {
      return ApiErrors.badRequest('Invalid JSON body');
    }

    // Validate request body with Zod
    const parsed = processReleaseSchema.safeParse(rawBody);
    if (!parsed.success) {
      const message = parsed.error.errors.map(e => e.message).join(', ');
      return ApiErrors.badRequest(message);
    }
    const bodyData = parsed.data;

    // Admin authentication required - pass body data for adminKey check
    const authError = await requireAdminAuth(request, locals, bodyData as Record<string, unknown>);
    if (authError) return authError;

  // Rate limit: write operations - 30 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`process-release:${clientId}`, RateLimiters.write);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const fbCtx = getAdminFirebaseContext(locals);
  if (fbCtx instanceof Response) return fbCtx;
  const { env, projectId, saKey: serviceAccountKey } = fbCtx;

  // R2 public domain for CDN URLs
  const publicDomain = env?.R2_PUBLIC_DOMAIN || import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk';

  // Access native R2 binding
  const r2: R2Bucket = locals.runtime.env.R2;

  try {
    let { submissionId } = bodyData;

    // Check if submission is from root level (prefixed with "root:")
    const isRootLevel = submissionId.startsWith('root:');
    if (isRootLevel) {
      submissionId = submissionId.replace('root:', '');
    }

    log.info(`Processing: ${submissionId} (root: ${isRootLevel})`);

    // Get metadata from submission (handle root vs submissions folder)
    // Try info.json first (new uploader format), then metadata.json (legacy)
    const submissionPrefix = isRootLevel ? submissionId : `submissions/${submissionId}`;

    let metadata: Record<string, unknown> | null = null;

    // Try info.json first (new uploader format)
    const infoKey = `${submissionPrefix}/info.json`;
    const infoObj = await r2.get(infoKey);

    if (infoObj) {
      metadata = await infoObj.json();
    } else {
      // Fall back to metadata.json
      const metadataKey = `${submissionPrefix}/metadata.json`;
      const metaObj = await r2.get(metadataKey);
      if (metaObj) {
        metadata = await metaObj.json();
      }
    }

    if (!metadata) {
      log.error(`Metadata not found at ${submissionPrefix}/info.json or metadata.json`);
      return ApiErrors.notFound('Metadata not found - ensure info.json exists in submission folder');
    }

    // Normalize metadata field names — different upload paths may use different keys
    const artistName = String(metadata.artistName || metadata.artist || metadata.artist_name || 'Unknown Artist');
    const releaseName = String(metadata.releaseName || metadata.title || metadata.release_name || metadata.album || 'Unknown Release');
    // Store back for downstream use
    metadata.artistName = artistName;
    metadata.releaseName = releaseName;

    log.info(`Loaded metadata: ${artistName} - ${releaseName}`);
    log.debug('Metadata keys:', Object.keys(metadata).join(', '));

    // List all files in submission folder (handle pagination)
    const files: string[] = [];
    const fileSizes: Map<string, number> = new Map();

    let cursor: string | undefined;
    let truncated = true;
    while (truncated) {
      const listResult = await r2.list({ prefix: `${submissionPrefix}/`, cursor });
      for (const obj of listResult.objects) {
        files.push(obj.key);
        fileSizes.set(obj.key, obj.size);
      }
      truncated = listResult.truncated;
      cursor = listResult.truncated ? listResult.cursor : undefined;
    }

    // Find artwork and audio files
    let artworkKey: string | null = null;
    let audioFiles: string[] = [];

    log.debug(`Files in submission:`, files);

    for (const file of files) {
      const lower = file.toLowerCase();
      const filename = file.split('/').pop() || '';

      // Skip metadata.json
      if (filename === 'metadata.json') continue;

      if (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.webp')) {
        artworkKey = file;
        log.debug(`Found artwork: ${file}`);
      } else if (lower.endsWith('.wav') || lower.endsWith('.mp3') || lower.endsWith('.flac')) {
        audioFiles.push(file);
        log.debug(`Found audio: ${file}`);
      }
    }

    // Server-side file size validation
    const MAX_SINGLE_AUDIO_SIZE = 200 * 1024 * 1024; // 200MB per file
    const MAX_TOTAL_UPLOAD_SIZE = 2 * 1024 * 1024 * 1024; // 2GB total
    let totalUploadSize = 0;

    for (const audioFile of audioFiles) {
      const fileSize = fileSizes.get(audioFile) || 0;
      totalUploadSize += fileSize;

      if (fileSize > MAX_SINGLE_AUDIO_SIZE) {
        const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
        const filename = audioFile.split('/').pop() || audioFile;
        log.error(`Audio file too large: ${filename} (${sizeMB}MB, max 200MB)`);
        return ApiErrors.badRequest(`Audio file "${filename}" is ${sizeMB}MB which exceeds the 200MB limit per file`);
      }
    }

    if (totalUploadSize > MAX_TOTAL_UPLOAD_SIZE) {
      const totalGB = (totalUploadSize / (1024 * 1024 * 1024)).toFixed(2);
      log.error(`Total upload size too large: ${totalGB}GB (max 2GB)`);
      return ApiErrors.badRequest(`Total upload size is ${totalGB}GB which exceeds the 2GB limit`);
    }

    log.info(`Found ${audioFiles.length} audio files, artwork: ${artworkKey || 'none'}`);

    // Generate release ID and folder name
    const timestamp = Date.now();
    const sanitizedArtist = artistName.toLowerCase().replace(/[^a-z0-9]+/g, '_').substring(0, 30);
    const releaseId = `${sanitizedArtist}_FW-${timestamp}`;
    const releaseFolderName = createReleaseFolderName(artistName, releaseName);
    const releaseFolder = `releases/${releaseFolderName}`;

    log.info(`Target folder: ${releaseFolder}`);

    // Use native R2 get+put to copy files from submissions/ to releases/ folder
    const copiedFiles: { oldKey: string; newKey: string }[] = [];

    // Helper function for server-side copy via get+put (R2 native binding)
    async function copyObject(sourceKey: string, destKey: string): Promise<boolean> {
      const sourceObj = await r2.get(sourceKey);
      if (!sourceObj) return false;
      const httpMetadata = { ...sourceObj.httpMetadata };
      if (!httpMetadata.cacheControl) {
        httpMetadata.cacheControl = 'public, max-age=31536000, immutable';
      }
      await r2.put(destKey, sourceObj.body, {
        httpMetadata,
        customMetadata: sourceObj.customMetadata,
      });
      return true;
    }

    // Process artwork: validate, convert to WebP, create cover + thumb
    // Keep original full-res for buyer downloads
    let artworkUrl = `${publicDomain}/place-holder.webp`;
    let thumbUrl = artworkUrl;
    let originalArtworkUrl = '';

    const artworkResult = await processReleaseArtwork({
      artworkKey,
      artworkSize: artworkKey ? (fileSizes.get(artworkKey) || 0) : 0,
      r2,
      releaseFolder,
      publicDomain,
      copyObject,
      log,
    });

    // If processReleaseArtwork returned a Response, it's a validation error
    if (artworkResult instanceof Response) {
      return artworkResult;
    }

    artworkUrl = artworkResult.artworkUrl;
    thumbUrl = artworkResult.thumbUrl;
    originalArtworkUrl = artworkResult.originalArtworkUrl;
    copiedFiles.push(...artworkResult.copiedFiles);

    // Copy audio files in parallel and build new URLs
    let newAudioFiles: { oldKey: string; newKey: string; url: string }[] = [];
    const copyResults = await Promise.allSettled(
      audioFiles.map(async (audioFile) => {
        const audioFilename = audioFile.split('/').pop() || 'track.wav';
        const newAudioKey = `${releaseFolder}/${audioFilename}`;
        const copied = await copyObject(audioFile, newAudioKey);
        return { audioFile, audioFilename, newAudioKey, copied };
      })
    );
    for (const result of copyResults) {
      if (result.status === 'fulfilled' && result.value.copied) {
        const { audioFile, audioFilename, newAudioKey } = result.value;
        copiedFiles.push({ oldKey: audioFile, newKey: newAudioKey });
        newAudioFiles.push({
          oldKey: audioFile,
          newKey: newAudioKey,
          url: `${publicDomain}/${newAudioKey}`
        });
        log.debug(`Copied audio: ${audioFilename}`);
      } else if (result.status === 'fulfilled') {
        log.warn(`Failed to copy audio: ${result.value.audioFile}`);
      } else {
        log.warn(`Audio copy error: ${result.reason}`);
      }
    }

    log.info(`Copied ${copiedFiles.length} files to ${releaseFolder}`);

    // Update audioFiles reference to use new keys
    audioFiles = newAudioFiles.map(f => f.newKey);

    // Build tracks - match metadata tracks to audio files by name
    const { tracks } = buildTrackArray({ metadata, newAudioFiles, log });

    log.info(`Built ${tracks.length} tracks`);

    // Parse metadata tracks count for validation (same logic as buildTrackArray)
    let metadataTrackCount = 0;
    if (metadata.tracks && Array.isArray(metadata.tracks)) {
      metadataTrackCount = metadata.tracks.length;
    } else if (metadata.trackListingJSON) {
      try {
        metadataTrackCount = JSON.parse(metadata.trackListingJSON as string).length;
      } catch (e: unknown) {
        // Already logged in buildTrackArray
      }
    }

    // Validate: if metadata has tracks but we found none, fail
    if (metadataTrackCount > 0 && tracks.length === 0) {
      log.error(`Track mismatch: metadata has ${metadataTrackCount} tracks but no audio files were found/matched`);
      return ApiErrors.badRequest(`No audio files found for ${metadataTrackCount} track(s). Please ensure audio files are uploaded with the submission.`);
    }

    // Warn if metadata track count doesn't match audio files found
    const trackCountMismatch = metadataTrackCount > 0 && metadataTrackCount !== tracks.length;
    if (trackCountMismatch) {
      log.warn(`Track count mismatch: metadata has ${metadataTrackCount} tracks, found ${tracks.length} audio files`);
    }

    const now = new Date().toISOString();

    // Look up artist by email to get proper ownership ID
    let artistOwnerId = '';
    let artistOwnerEmail = String(metadata.email || '');
    if (artistOwnerEmail) {
      try {
        // Normalize email for lookup (handle gmail/googlemail)
        const normalizedEmail = artistOwnerEmail.toLowerCase().replace('@googlemail.com', '@gmail.com');

        // Query artists collection by email
        const artists = await saQueryCollection(serviceAccountKey, projectId, 'artists', {
          filters: [{ field: 'email', op: '==', value: normalizedEmail }]
        });
        if (artists && artists.length > 0) {
          artistOwnerId = artists[0].id;
          log.info(`Found artist by email: ${artistOwnerId}`);
        } else {
          // Also try the original email if normalization changed it
          if (normalizedEmail !== artistOwnerEmail.toLowerCase()) {
            const artists2 = await saQueryCollection(serviceAccountKey, projectId, 'artists', {
              filters: [{ field: 'email', op: '==', value: artistOwnerEmail.toLowerCase() }]
            });
            if (artists2 && artists2.length > 0) {
              artistOwnerId = artists2[0].id;
              log.info(`Found artist by original email: ${artistOwnerId}`);
            }
          }
        }
        if (!artistOwnerId) {
          log.warn(`No artist found for email: ${artistOwnerEmail}`);
        }
      } catch (err: unknown) {
        log.warn(`Failed to lookup artist by email: ${err}`);
      }
    }

    // Build release document
    const releaseData = {
      id: releaseId,
      title: metadata.releaseName,
      artist: metadata.artistName,
      artistName: metadata.artistName,
      releaseName: metadata.releaseName,
      r2FolderName: releaseFolderName,
      r2FolderPath: releaseFolder,
      // Include all artwork field variations used by different pages
      coverUrl: artworkUrl,
      coverArtUrl: artworkUrl,
      artworkUrl: artworkUrl,
      thumbUrl: thumbUrl,
      imageUrl: artworkUrl,
      originalArtworkUrl: originalArtworkUrl,
      genre: metadata.genre || 'Drum and Bass',
      catalogNumber: metadata.labelCode || '',
      labelCode: metadata.labelCode || '',
      releaseDate: metadata.releaseDate || now,
      originalReleaseDate: metadata.copyrightYear ? `${metadata.copyrightYear}-01-01` : (metadata.releaseDate || now),
      description: metadata.releaseDescription || metadata.notes || '',
      releaseDescription: metadata.releaseDescription || '',
      masteredBy: metadata.masteredBy || '',

      // Pricing
      pricePerSale: Math.max(0, parseFloat(metadata.pricePerSale) || 0) || 7.99,
      trackPrice: Math.max(0, parseFloat(metadata.trackPrice) || 0) || 1.99,

      // Copyright
      copyrightYear: metadata.copyrightYear || new Date().getFullYear().toString(),
      copyrightHolder: metadata.copyrightHolder || metadata.artistName,
      publishingRights: metadata.publishingRights || '',
      publishingCompany: metadata.publishingCompany || '',

      // Vinyl
      vinylRelease: metadata.vinylRelease || false,
      vinylPrice: Math.max(0, parseFloat(metadata.vinylPrice) || 0),

      // Status
      status: 'pending',
      published: false,
      approved: false,
      storage: 'r2',

      // Tracks
      tracks: tracks,

      // Stats
      plays: 0,
      downloads: 0,
      views: 0,
      likes: 0,
      ratings: { average: 0, count: 0, total: 0 },

      // Timestamps
      createdAt: now,
      updatedAt: now,
      processedAt: now,

      // Original submission & ownership
      submissionId: submissionId,
      email: metadata.email || '',
      submittedBy: metadata.submittedBy || '',
      submitterEmail: artistOwnerEmail,
      submitterId: artistOwnerId,
      artistId: artistOwnerId
    };

    // Save to Firebase using service account auth
    await saSetDocument(serviceAccountKey, projectId, 'releases', releaseId, releaseData);

    // Invalidate releases cache so new release appears in listings
    invalidateReleasesCache();
    clearCache(`doc:releases:${releaseId}`);
    // Invalidate KV cache for releases list so all edge workers serve fresh data
    await invalidateReleasesKVCache();

    log.info(`Created release: ${releaseId}`);

    // Delete submission files after successful processing (but keep if track count mismatch)
    if (trackCountMismatch) {
      log.warn(`Keeping submission files due to track count mismatch (metadata: ${metadataTrackCount}, actual: ${tracks.length})`);
    } else {
      try {
        log.info(`Deleting submission files from ${submissionPrefix}/`);
        const keysToDelete = files.map(f => f);
        await r2.delete(keysToDelete);
        log.info(`Deleted ${keysToDelete.length} submission files`);
      } catch (deleteError: unknown) {
        log.warn('Failed to delete some submission files:', deleteError);
      }
    }

    return successResponse({
      releaseId,
      artist: metadata.artistName,
      title: metadata.releaseName,
      tracks: tracks.length,
      coverUrl: artworkUrl,
      ...(trackCountMismatch ? { warning: `Track count mismatch: metadata has ${metadataTrackCount} tracks but only ${tracks.length} audio file(s) were found. Submission files kept for re-processing.` } : {})
    });

  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error('Inner error:', errMsg);
    return errorResponse('Processing failed');
  }

  } catch (outerError: unknown) {
    const errMsg = outerError instanceof Error ? outerError.message : String(outerError);
    log.error('Outer error (uncaught):', errMsg);
    return errorResponse('An internal error occurred');
  }
};
