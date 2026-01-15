// src/pages/api/process-release.ts
// Process a release submission from R2 - creates Firebase entry
// Copies files from submissions/ to releases/ folder for organization

import type { APIRoute } from 'astro';
import { AwsClient } from 'aws4fetch';
import { saSetDocument, saQueryCollection } from '../../lib/firebase-service-account';
import { createLogger, errorResponse, successResponse, getEnv, ApiErrors } from '../../lib/api-utils';
import { requireAdminAuth } from '../../lib/admin';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';
import type { Track } from '../../lib/types';

const log = createLogger('process-release');

// Build service account key from individual env vars
function getServiceAccountKey(env: any): string | null {
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';
  const clientEmail = env?.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env?.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) return null;

  return JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'auto',
    private_key: privateKey.replace(/\\n/g, '\n'),
    client_email: clientEmail,
    client_id: '',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token'
  });
}

// Get R2 configuration
function getR2Config(env: any) {
  return {
    accountId: env?.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
    bucketName: 'freshwax-releases',
    publicDomain: env?.R2_PUBLIC_DOMAIN || import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk',
  };
}

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
    let bodyData: any;
    try {
      bodyData = await request.json();
    } catch {
      return ApiErrors.badRequest('Invalid JSON body');
    }

    // Admin authentication required - pass body data for adminKey check
    const authError = requireAdminAuth(request, locals, bodyData);
    if (authError) return authError;

  // Rate limit: write operations - 30 per minute
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`process-release:${clientId}`, RateLimiters.write);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = getEnv(locals);

  // Get service account key for Firestore writes
  const serviceAccountKey = getServiceAccountKey(env);
  const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

  if (!serviceAccountKey) {
    return ApiErrors.notConfigured('Firebase service account');
  }

  try {
    let { submissionId } = bodyData;

    if (!submissionId) {
      return ApiErrors.badRequest('submissionId required');
    }

    // Check if submission is from root level (prefixed with "root:")
    const isRootLevel = submissionId.startsWith('root:');
    if (isRootLevel) {
      submissionId = submissionId.replace('root:', '');
    }

    log.info(`Processing: ${submissionId} (root: ${isRootLevel})`);

    // Initialize R2 client
    const R2_CONFIG = getR2Config(env);

    if (!R2_CONFIG.accessKeyId || !R2_CONFIG.secretAccessKey) {
      return ApiErrors.notConfigured('R2');
    }

    const awsClient = new AwsClient({
      accessKeyId: R2_CONFIG.accessKeyId,
      secretAccessKey: R2_CONFIG.secretAccessKey,
      service: 's3',
      region: 'auto',
    });

    const endpoint = `https://${R2_CONFIG.accountId}.r2.cloudflarestorage.com`;
    const bucketUrl = `${endpoint}/${R2_CONFIG.bucketName}`;

    // Get metadata from submission (handle root vs submissions folder)
    // Try info.json first (new uploader format), then metadata.json (legacy)
    const submissionPrefix = isRootLevel ? submissionId : `submissions/${submissionId}`;

    let metadataResponse: Response | null = null;

    // Try info.json first (new uploader format)
    const infoKey = `${submissionPrefix}/info.json`;
    const infoUrl = `${bucketUrl}/${encodeURIComponent(infoKey)}`;
    metadataResponse = await awsClient.fetch(infoUrl);

    // Fall back to metadata.json if info.json not found
    if (!metadataResponse.ok) {
      const metadataKey = `${submissionPrefix}/metadata.json`;
      const metadataUrl = `${bucketUrl}/${encodeURIComponent(metadataKey)}`;
      metadataResponse = await awsClient.fetch(metadataUrl);
    }

    if (!metadataResponse.ok) {
      log.error(`Metadata not found at ${submissionPrefix}/info.json or metadata.json`);
      return ApiErrors.notFound('Metadata not found - ensure info.json exists in submission folder');
    }

    const metadata = await metadataResponse.json() as any;
    log.info(`Loaded metadata: ${metadata.artistName} - ${metadata.releaseName}`);

    // List all files in submission folder
    const listUrl = `${bucketUrl}?list-type=2&prefix=${submissionPrefix}/`;
    const listResponse = await awsClient.fetch(listUrl);
    const listXml = await listResponse.text();

    const keyMatches = listXml.matchAll(/<Key>([^<]+)<\/Key>/g);
    const files: string[] = [];
    for (const match of keyMatches) {
      files.push(match[1]);
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

    log.info(`Found ${audioFiles.length} audio files, artwork: ${artworkKey || 'none'}`);

    // Generate release ID and folder name
    const timestamp = Date.now();
    const sanitizedArtist = metadata.artistName.toLowerCase().replace(/[^a-z0-9]+/g, '_').substring(0, 30);
    const releaseId = `${sanitizedArtist}_FW-${timestamp}`;
    const releaseFolderName = createReleaseFolderName(metadata.artistName, metadata.releaseName);
    const releaseFolder = `releases/${releaseFolderName}`;

    log.info(`Target folder: ${releaseFolder}`);

    // Use server-side copy to move files from submissions/ to releases/ folder
    // This avoids loading large files into memory (R2 CopyObject via x-amz-copy-source header)
    const copiedFiles: { oldKey: string; newKey: string }[] = [];

    // Helper function for server-side copy (no memory overhead)
    async function copyObject(sourceKey: string, destKey: string): Promise<boolean> {
      const destUrl = `${bucketUrl}/${encodeURIComponent(destKey)}`;
      const copySource = `/${R2_CONFIG.bucketName}/${sourceKey}`;

      const copyResponse = await awsClient.fetch(destUrl, {
        method: 'PUT',
        headers: {
          'x-amz-copy-source': copySource
        }
      });

      return copyResponse.ok;
    }

    // Copy artwork
    let artworkUrl = `${R2_CONFIG.publicDomain}/place-holder.webp`;
    if (artworkKey) {
      const artworkFilename = artworkKey.split('/').pop() || 'cover.webp';
      const newArtworkKey = `${releaseFolder}/${artworkFilename}`;

      const copied = await copyObject(artworkKey, newArtworkKey);
      if (copied) {
        copiedFiles.push({ oldKey: artworkKey, newKey: newArtworkKey });
        artworkUrl = `${R2_CONFIG.publicDomain}/${newArtworkKey}`;
        log.debug(`Copied artwork: ${artworkFilename}`);
      } else {
        log.warn(`Failed to copy artwork: ${artworkKey}`);
      }
    }

    // Copy audio files and build new URLs
    let newAudioFiles: { oldKey: string; newKey: string; url: string }[] = [];
    for (const audioFile of audioFiles) {
      const audioFilename = audioFile.split('/').pop() || 'track.wav';
      const newAudioKey = `${releaseFolder}/${audioFilename}`;

      const copied = await copyObject(audioFile, newAudioKey);
      if (copied) {
        copiedFiles.push({ oldKey: audioFile, newKey: newAudioKey });
        newAudioFiles.push({
          oldKey: audioFile,
          newKey: newAudioKey,
          url: `${R2_CONFIG.publicDomain}/${newAudioKey}`
        });
        log.debug(`Copied audio: ${audioFilename}`);
      } else {
        log.warn(`Failed to copy audio: ${audioFile}`);
      }
    }

    log.info(`Copied ${copiedFiles.length} files to ${releaseFolder}`);

    // Update audioFiles reference to use new keys
    audioFiles = newAudioFiles.map(f => f.newKey);

    // Build tracks - match metadata tracks to audio files by name
    const tracks: any[] = [];

    // Parse tracks from metadata - try tracks array first, then trackListingJSON string
    let metadataTracks: any[] = [];
    if (metadata.tracks && Array.isArray(metadata.tracks)) {
      metadataTracks = metadata.tracks;
    } else if (metadata.trackListingJSON) {
      try {
        metadataTracks = JSON.parse(metadata.trackListingJSON);
      } catch (e) {
        log.warn('Failed to parse trackListingJSON:', e);
      }
    }

    log.debug(`Metadata tracks (${metadataTracks.length}):`, metadataTracks);
    log.debug(`Audio files:`, audioFiles);

    // Helper to normalize names for matching (lowercase, remove special chars)
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

    // For each metadata track, find the matching audio file from newAudioFiles
    for (let i = 0; i < metadataTracks.length; i++) {
      const metaTrack = metadataTracks[i];
      const trackName = metaTrack.title || metaTrack.trackName || '';
      const normalizedTrackName = normalize(trackName);

      log.debug(`Looking for audio file matching: "${trackName}"`);

      // Find audio file that contains this track name (from copied files)
      let matchedAudio = newAudioFiles.find(audioFile => {
        const filename = audioFile.newKey.split('/').pop() || '';
        const normalizedFilename = normalize(filename);
        return normalizedFilename.includes(normalizedTrackName) && normalizedTrackName.length > 2;
      });

      // If no match found, use first remaining audio file as fallback
      if (!matchedAudio && newAudioFiles.length > 0) {
        matchedAudio = newAudioFiles[0];
        log.debug(`No name match, using first remaining file: ${matchedAudio.newKey}`);
      }

      if (!matchedAudio) {
        log.warn(`No audio file found for track ${i + 1}: ${trackName}`);
        continue;
      }

      // Use the URL from the copied file (already in releases folder)
      const audioUrl = matchedAudio.url;

      log.debug(`Track ${i + 1}: "${trackName}" -> ${matchedAudio.newKey}`);

      tracks.push({
        trackNumber: metaTrack.trackNumber || i + 1,
        title: trackName || `Track ${i + 1}`,
        trackName: trackName || `Track ${i + 1}`,
        mp3Url: audioUrl,
        wavUrl: audioUrl,
        previewUrl: audioUrl,
        bpm: metaTrack.bpm || '',
        key: metaTrack.key || '',
        duration: metaTrack.duration || '',
        trackISRC: metaTrack.trackISRC || '',
        featured: metaTrack.featured || '',
        remixer: metaTrack.remixer || '',
        storage: 'r2'
      });

      // Remove matched file from list to prevent duplicates
      newAudioFiles = newAudioFiles.filter(f => f !== matchedAudio);
    }

    // Add any remaining unmatched audio files
    for (let i = 0; i < newAudioFiles.length; i++) {
      const audioFile = newAudioFiles[i];
      const filename = audioFile.newKey.split('/').pop() || '';
      const trackNameFromFile = filename
        .replace(/\.(wav|mp3|flac)$/i, '')
        .replace(/^\d+[\s._-]+/, '')
        .trim();

      const audioUrl = audioFile.url;

      log.debug(`Unmatched track: "${trackNameFromFile}" -> ${filename}`);

      tracks.push({
        trackNumber: tracks.length + 1,
        title: trackNameFromFile || `Track ${tracks.length + 1}`,
        trackName: trackNameFromFile || `Track ${tracks.length + 1}`,
        mp3Url: audioUrl,
        wavUrl: audioUrl,
        previewUrl: audioUrl,
        bpm: '',
        key: '',
        duration: '',
        trackISRC: '',
        featured: '',
        remixer: '',
        storage: 'r2'
      });
    }

    log.info(`Built ${tracks.length} tracks`);

    // Validate: if metadata has tracks but we found none, fail
    if (metadataTracks.length > 0 && tracks.length === 0) {
      log.error(`Track mismatch: metadata has ${metadataTracks.length} tracks but no audio files were found/matched`);
      return ApiErrors.badRequest(`No audio files found for ${metadataTracks.length} track(s). Please ensure audio files are uploaded with the submission.`);
    }

    const now = new Date().toISOString();

    // Look up artist by email to get proper ownership ID
    let artistOwnerId = '';
    let artistOwnerEmail = metadata.email || '';
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
      } catch (err) {
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
      thumbUrl: artworkUrl,
      imageUrl: artworkUrl,
      genre: metadata.genre || 'Drum and Bass',
      catalogNumber: metadata.labelCode || '',
      labelCode: metadata.labelCode || '',
      releaseDate: metadata.releaseDate || now,
      originalReleaseDate: metadata.copyrightYear ? `${metadata.copyrightYear}-01-01` : (metadata.releaseDate || now),
      description: metadata.releaseDescription || metadata.notes || '',
      releaseDescription: metadata.releaseDescription || '',
      masteredBy: metadata.masteredBy || '',

      // Pricing
      pricePerSale: parseFloat(metadata.pricePerSale) || 7.99,
      trackPrice: parseFloat(metadata.trackPrice) || 1.99,

      // Copyright
      copyrightYear: metadata.copyrightYear || new Date().getFullYear().toString(),
      copyrightHolder: metadata.copyrightHolder || metadata.artistName,
      publishingRights: metadata.publishingRights || '',
      publishingCompany: metadata.publishingCompany || '',

      // Vinyl
      vinylRelease: metadata.vinylRelease || false,
      vinylPrice: parseFloat(metadata.vinylPrice) || 0,

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

    log.info(`Created release: ${releaseId}`);

    // Delete submission files after successful processing
    try {
      log.info(`Deleting submission files from ${submissionPrefix}/`);
      for (const file of files) {
        const deleteUrl = `${bucketUrl}/${encodeURIComponent(file)}`;
        await awsClient.fetch(deleteUrl, { method: 'DELETE' });
        log.debug(`Deleted: ${file}`);
      }
      log.info(`Deleted ${files.length} submission files`);
    } catch (deleteError) {
      log.warn('Failed to delete some submission files:', deleteError);
    }

    return successResponse({
      releaseId,
      artist: metadata.artistName,
      title: metadata.releaseName,
      tracks: tracks.length,
      coverUrl: artworkUrl
    });

  } catch (error) {
    log.error('Inner error:', error);
    return errorResponse(error instanceof Error ? error.message : 'Processing failed');
  }

  } catch (outerError) {
    log.error('Outer error (uncaught):', outerError);
    return errorResponse(outerError instanceof Error ? outerError.message : 'Unexpected error');
  }
};
