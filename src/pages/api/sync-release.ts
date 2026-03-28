import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getDocument, setDocument } from '../../lib/firebase-rest';
import { processImageToSquareWebP, imageExtension, imageContentType } from '../../lib/image-processing';
import { requireAdminAuth } from '../../lib/admin';
import AdmZip from 'adm-zip';
import { ApiErrors, createLogger, successResponse } from '../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

export const prerender = false;

const log = createLogger('sync-release');

// Cloudflare Workers-compatible replacements for getExtname and getBasename
function getExtname(filePath: string): string {
  const name = filePath.includes('/') ? filePath.slice(filePath.lastIndexOf('/') + 1) : filePath;
  const dotIndex = name.lastIndexOf('.');
  return dotIndex > 0 ? name.slice(dotIndex) : '';
}

function getBasename(filePath: string): string {
  const trimmed = filePath.endsWith('/') ? filePath.slice(0, -1) : filePath;
  const slashIndex = trimmed.lastIndexOf('/');
  return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
}

// Audio file extensions
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.flac', '.aiff', '.aif', '.m4a'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

export const POST = async ({ request, locals }: { request: Request; locals: App.Locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`sync-release:${clientId}`, RateLimiters.adminBulk);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);

  try {
    // SECURITY: Require admin authentication
    const authError = await requireAdminAuth(request, locals);
    if (authError) return authError;

    log.info('[sync-release] Sync release API called');

    const formData = await request.formData();
    const zipFile = formData.get('zipFile');

    if (!zipFile) {
      return ApiErrors.badRequest('No ZIP file provided');
    }

    const env = locals?.runtime?.env || {};
    const config = {
      r2: {
        accountId: env.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
        accessKeyId: env.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
        bucketName: env.R2_RELEASES_BUCKET || import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
        publicDomain: env.R2_PUBLIC_DOMAIN || import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk',
      },
      firebase: {
        projectId: env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
        privateKey: env.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY,
        clientEmail: env.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL,
      },
    };

    if (!config.r2.accountId || !config.r2.accessKeyId || !config.r2.secretAccessKey) {
      throw new Error('R2 credentials not configured');
    }
    if (!config.firebase.projectId || !config.firebase.privateKey || !config.firebase.clientEmail) {
      throw new Error('Firebase credentials not configured');
    }

    log.info('[sync-release] Configuration validated');

    // Read ZIP file
    const buffer = Buffer.from(await zipFile.arrayBuffer());
    const zip = new AdmZip(buffer);
    const zipEntries = zip.getEntries();
    
    // Check if this is a pre-processed package or raw ZIP
    const hasReleasesFolder = zipEntries.some(e => e.entryName.startsWith('releases/'));
    const hasMetadata = zipEntries.some(e => e.entryName.includes('firebase-metadata.json'));
    
    let release: Record<string, unknown> | null = null;
    let releaseId: string;

    if (hasReleasesFolder && hasMetadata) {
      // Pre-processed packages require filesystem access (R2FirebaseSync uses fs/path)
      // which is not available in Cloudflare Workers. Use raw ZIP upload instead.
      return ApiErrors.badRequest('Pre-processed packages are not supported in this environment. Please upload a raw ZIP file with audio tracks and cover art.');
    } else {
      // Raw ZIP - process directly
      log.info('[sync-release] Detected raw ZIP, processing directly');
      
      const originalFilename = zipFile.name || 'Unknown - Untitled.zip';
      const result = await processRawZip(zip, zipEntries, originalFilename, config);
      releaseId = result.releaseId;
      release = result.release;
    }

    // Fetch release data from Firebase if not already available
    if (!release) {
      try {

        const releaseDoc = await getDocument('releases', releaseId);

        if (releaseDoc) {
          release = releaseDoc;
          log.info('[sync-release] Fetched release data:', release.releaseName, 'by', release.artistName);
        }
      } catch (fetchError: unknown) {
        log.warn('[sync-release] Could not fetch release data:', fetchError);
      }
    }

    log.info('[sync-release] Success:', releaseId);

    return successResponse({ releaseId,
      release,
      message: 'Release synced successfully', });

  } catch (error: unknown) {
    log.error('[sync-release] Sync failed:', error);
    
    return ApiErrors.serverError('Sync failed');
  }
};

/**
 * Process a raw ZIP file (Artist - Release.zip with tracks and cover)
 */
async function processRawZip(
  zip: AdmZip, 
  zipEntries: AdmZip.IZipEntry[], 
  filename: string,
  config: { r2: Record<string, string>; firebase: Record<string, string> }
): Promise<{ releaseId: string; release: Record<string, unknown> }> {
  
  // Parse artist and release name from filename
  // Expected format: "Artist Name - Release Name.zip"
  const baseName = filename.replace(/\.zip$/i, '');
  let artistName = 'Unknown Artist';
  let releaseName = 'Unknown Release';
  
  if (baseName.includes(' - ')) {
    const parts = baseName.split(' - ');
    artistName = parts[0].trim();
    releaseName = parts.slice(1).join(' - ').trim();
  } else {
    releaseName = baseName.trim();
  }
  
  log.info(`[sync-release] Parsed: "${artistName}" - "${releaseName}"`);
  
  // Generate release ID
  const sanitize = (str: string) => str.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20);
  const releaseId = `${sanitize(artistName)}_FW-${Date.now()}`;
  
  // Find cover art
  let coverEntry: AdmZip.IZipEntry | null = null;
  let coverUrl = '';
  
  for (const entry of zipEntries) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.toLowerCase();
    const ext = getExtname(name);
    
    if (IMAGE_EXTENSIONS.includes(ext)) {
      // Prefer files named "cover" or "artwork"
      if (name.includes('cover') || name.includes('artwork') || name.includes('front')) {
        coverEntry = entry;
        break;
      }
      // Otherwise use first image found
      if (!coverEntry) {
        coverEntry = entry;
      }
    }
  }
  
  // Find audio tracks
  const audioEntries: Array<{ entry: AdmZip.IZipEntry; trackNumber: number; title: string }> = [];
  
  for (const entry of zipEntries) {
    if (entry.isDirectory) continue;
    const name = getBasename(entry.entryName);
    const ext = getExtname(name).toLowerCase();
    
    if (AUDIO_EXTENSIONS.includes(ext)) {
      // Try to parse track number from filename
      // Patterns: "01 - Track Name.mp3", "01_Track Name.mp3", "1. Track Name.mp3"
      const nameWithoutExt = name.replace(ext, '');
      let trackNumber = audioEntries.length + 1;
      let title = nameWithoutExt;
      
      const match = nameWithoutExt.match(/^(\d+)[\s._-]+(.+)$/);
      if (match) {
        trackNumber = parseInt(match[1], 10);
        title = match[2].trim();
      }
      
      audioEntries.push({ entry, trackNumber, title });
    }
  }
  
  // Sort by track number
  audioEntries.sort((a, b) => a.trackNumber - b.trackNumber);
  
  log.info(`[sync-release] Found ${audioEntries.length} tracks, cover: ${coverEntry ? 'yes' : 'no'}`);
  
  if (audioEntries.length === 0) {
    throw new Error('No audio files found in ZIP. Supported formats: MP3, WAV, FLAC, AIFF');
  }
  
  // Initialize S3 client for R2
  const s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.r2.accessKeyId,
      secretAccessKey: config.r2.secretAccessKey,
    },
  });
  
  // Upload cover art (convert to WebP + keep original for buyer downloads)
  let thumbUrl = '';
  let originalArtworkUrl = '';
  if (coverEntry) {
    const coverBuffer = coverEntry.getData();
    const ext = getExtname(coverEntry.entryName).toLowerCase();
    const contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';

    // Always upload original full-res for buyer downloads
    const originalKey = `releases/${releaseId}/artwork/original${ext}`;
    await s3Client.send(new PutObjectCommand({
      Bucket: config.r2.bucketName,
      Key: originalKey,
      Body: coverBuffer,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000',
    }));
    originalArtworkUrl = `${config.r2.publicDomain}/${originalKey}`;
    log.info(`[sync-release] Uploaded original: ${originalArtworkUrl}`);

    try {
      const coverResult = await processImageToSquareWebP(coverBuffer.buffer as ArrayBuffer, 800, 80);
      const thumbResult = await processImageToSquareWebP(coverBuffer.buffer as ArrayBuffer, 400, 75);

      const coverKey = `releases/${releaseId}/artwork/cover${imageExtension(coverResult.format)}`;
      const thumbKey = `releases/${releaseId}/artwork/thumb${imageExtension(thumbResult.format)}`;

      await Promise.all([
        s3Client.send(new PutObjectCommand({
          Bucket: config.r2.bucketName,
          Key: coverKey,
          Body: coverResult.buffer,
          ContentType: imageContentType(coverResult.format),
          CacheControl: 'public, max-age=31536000',
        })),
        s3Client.send(new PutObjectCommand({
          Bucket: config.r2.bucketName,
          Key: thumbKey,
          Body: thumbResult.buffer,
          ContentType: imageContentType(thumbResult.format),
          CacheControl: 'public, max-age=31536000',
        })),
      ]);

      coverUrl = `${config.r2.publicDomain}/${coverKey}`;
      thumbUrl = `${config.r2.publicDomain}/${thumbKey}`;
      log.info(`[sync-release] Uploaded cover: ${coverUrl} (${(coverResult.buffer.length / 1024).toFixed(1)}KB)`);
      log.info(`[sync-release] Uploaded thumb: ${thumbUrl} (${(thumbResult.buffer.length / 1024).toFixed(1)}KB)`);
    } catch (imgErr: unknown) {
      log.warn('[sync-release] WebP conversion failed, using original as cover:', imgErr);
      coverUrl = originalArtworkUrl;
    }
  }
  
  // Upload tracks and build track list
  const tracks: Record<string, unknown>[] = [];
  
  for (const { entry, trackNumber, title } of audioEntries) {
    const ext = getExtname(entry.entryName).toLowerCase();
    const contentType = ext === '.mp3' ? 'audio/mpeg' : 
                        ext === '.wav' ? 'audio/wav' :
                        ext === '.flac' ? 'audio/flac' :
                        ext === '.m4a' ? 'audio/mp4' : 'audio/mpeg';
    
    // Upload full track
    const trackKey = `releases/${releaseId}/tracks/${trackNumber.toString().padStart(2, '0')}_${sanitizeFilename(title)}${ext}`;
    
    await s3Client.send(new PutObjectCommand({
      Bucket: config.r2.bucketName,
      Key: trackKey,
      Body: entry.getData(),
      ContentType: contentType,
    }));
    
    const trackUrl = `${config.r2.publicDomain}/${trackKey}`;
    
    tracks.push({
      id: `${releaseId}_track_${trackNumber}`,
      trackNumber,
      title,
      artist: artistName,
      artistName,
      duration: 0, // Would need audio parsing to get actual duration
      url: trackUrl,
      mp3Url: ext === '.mp3' ? trackUrl : null,
      wavUrl: ext === '.wav' ? trackUrl : null,
      preview_url: trackUrl, // Use full track as preview for now
      format: ext.replace('.', '').toUpperCase(),
      fileSize: entry.getData().length,
    });
    
    log.info(`[sync-release] Uploaded track ${trackNumber}: ${title}`);
  }
  

  // Create Firebase document
  const releaseDoc = {
    id: releaseId,
    artistName,
    releaseName,
    artist: artistName,
    title: releaseName,
    coverArtUrl: coverUrl,
    coverArt: coverUrl,
    thumbUrl,
    originalArtworkUrl,
    tracks,
    trackCount: tracks.length,
    status: 'pending', // Start as pending - admin must approve to go live
    approved: false,
    published: false,
    type: 'single',
    releaseType: tracks.length > 1 ? 'ep' : 'single',
    uploadedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    processedAt: new Date().toISOString(),
    catalogNumber: '',
    metadata: {
      uploadSource: 'admin-zip-upload',
      originalFilename: filename,
    },
  };

  await setDocument('releases', releaseId, releaseDoc);
  log.info(`[sync-release] Created release document: ${releaseId}`);

  return { releaseId, release: releaseDoc };
}

function sanitizeFilename(str: string): string {
  return str.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
}