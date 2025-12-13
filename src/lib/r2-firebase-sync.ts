// src/lib/r2-firebase-sync.ts
import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getDocument, queryCollection, setDocument, updateDocument, deleteDocument } from './firebase-rest';
import AdmZip from 'adm-zip';
import * as path from 'path';
import * as fs from 'fs';

// Conditional logging - only logs in development
const isDev = import.meta.env?.DEV ?? process.env.NODE_ENV !== 'production';
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicDomain: string;
}

interface FirebaseConfig {
  projectId: string;
  apiKey: string;
}

interface SyncConfig {
  r2: R2Config;
  firebase: FirebaseConfig;
  collections: {
    releases: string;
    tracks: string;
  };
}

export class R2FirebaseSync {
  private r2Client: S3Client;
  private config: SyncConfig;

  constructor(config: SyncConfig) {
    this.config = config;

    // Initialize R2 client
    this.r2Client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.r2.accessKeyId,
        secretAccessKey: config.r2.secretAccessKey,
      },
    });

    // Initialize Firebase REST API env (for write operations)
    if (typeof import.meta !== 'undefined' && import.meta.env) {
      (import.meta.env as any).FIREBASE_PROJECT_ID = config.firebase.projectId;
      (import.meta.env as any).FIREBASE_API_KEY = config.firebase.apiKey;
    }
  }

  /**
   * Main method: Process a packaged ZIP and sync everything
   */
  async processPackageAndSync(zipPath: string): Promise<string> {
    log.info('📦 Starting package processing...');

    // Extract ZIP
    const extractDir = await this.extractZip(zipPath);
    log.info(`✅ Extracted to: ${extractDir}`);

    // Find the release directory (should be releases/RELEASE_ID/)
    const releaseDirs = fs.readdirSync(path.join(extractDir, 'releases'));
    if (releaseDirs.length === 0) {
      throw new Error('No release directory found in ZIP');
    }

    const releaseId = releaseDirs[0];
    const releaseDir = path.join(extractDir, 'releases', releaseId);
    log.info(`🎵 Processing release: ${releaseId}`);

    // Read metadata
    const metadataPath = path.join(releaseDir, 'firebase-metadata.json');
    if (!fs.existsSync(metadataPath)) {
      throw new Error('firebase-metadata.json not found in package');
    }

    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    log.info(`📄 Loaded metadata for: ${metadata.artistName} - ${metadata.releaseName}`);

    // Upload files to R2
    const { coverFilename } = await this.uploadToR2(releaseId, releaseDir);
    log.info('✅ Files uploaded to R2');

    // Sync to Firebase
    await this.syncToFirebase(releaseId, metadata, coverFilename);
    log.info('✅ Synced to Firebase');

    // Cleanup
    this.cleanupExtractedFiles(extractDir);

    return releaseId;
  }

  /**
   * Extract ZIP file to temporary directory
   */
  private async extractZip(zipPath: string): Promise<string> {
    const zip = new AdmZip(zipPath);
    const extractDir = path.join(path.dirname(zipPath), `extract-${Date.now()}`);
    
    if (!fs.existsSync(extractDir)) {
      fs.mkdirSync(extractDir, { recursive: true });
    }

    zip.extractAllTo(extractDir, true);
    return extractDir;
  }

  /**
   * Upload all files from release directory to R2
   */
  private async uploadToR2(releaseId: string, releaseDir: string): Promise<{ coverFilename: string | null }> {
    const uploads: Promise<void>[] = [];
    let coverFilename: string | null = null;

    // Upload artwork
    const artworkDir = path.join(releaseDir, 'artwork');
    if (fs.existsSync(artworkDir)) {
      const artworkFiles = fs.readdirSync(artworkDir);
      for (const file of artworkFiles) {
        const filePath = path.join(artworkDir, file);
        const key = `releases/${releaseId}/artwork/${file}`;
        const contentType = file.endsWith('.webp') ? 'image/webp' : 
                           file.endsWith('.png') ? 'image/png' : 
                           file.endsWith('.jpg') || file.endsWith('.jpeg') ? 'image/jpeg' : 'image/webp';
        uploads.push(this.uploadFileToR2(filePath, key, contentType));
        
        // Track the cover file (first file or one named 'cover')
        if (!coverFilename || file.toLowerCase().startsWith('cover')) {
          coverFilename = file;
        }
      }
      log.info(`📸 Queued ${artworkFiles.length} artwork files, cover: ${coverFilename}`);
    }

    // Upload previews
    const previewsDir = path.join(releaseDir, 'previews');
    if (fs.existsSync(previewsDir)) {
      const previewFiles = fs.readdirSync(previewsDir);
      for (const file of previewFiles) {
        const filePath = path.join(previewsDir, file);
        const key = `releases/${releaseId}/previews/${file}`;
        uploads.push(this.uploadFileToR2(filePath, key, 'audio/mpeg'));
      }
      log.info(`🎵 Queued ${previewFiles.length} preview files`);
    }

    // Upload full tracks
    const tracksDir = path.join(releaseDir, 'tracks');
    if (fs.existsSync(tracksDir)) {
      const trackFiles = fs.readdirSync(tracksDir);
      for (const file of trackFiles) {
        const filePath = path.join(tracksDir, file);
        const key = `releases/${releaseId}/tracks/${file}`;
        const contentType = file.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';
        uploads.push(this.uploadFileToR2(filePath, key, contentType));
      }
      log.info(`💿 Queued ${trackFiles.length} track files`);
    }

    // Wait for all uploads
    await Promise.all(uploads);
    log.info(`✅ All files uploaded to R2`);
    
    return { coverFilename };
  }

  /**
   * Upload a single file to R2
   */
  private async uploadFileToR2(filePath: string, key: string, contentType: string): Promise<void> {
    const fileBuffer = fs.readFileSync(filePath);

    const command = new PutObjectCommand({
      Bucket: this.config.r2.bucketName,
      Key: key,
      Body: fileBuffer,
      ContentType: contentType,
    });

    await this.r2Client.send(command);
    log.info(`  ✓ Uploaded: ${key}`);
  }

  /**
   * Sync release metadata to Firebase
   */
  private async syncToFirebase(releaseId: string, metadata: any, coverFilename: string | null): Promise<void> {
    // Ensure URLs use the public domain
    const publicDomain = this.config.r2.publicDomain;

    // Update cover art URL - use actual uploaded filename
    if (coverFilename) {
      metadata.coverArtUrl = `${publicDomain}/releases/${releaseId}/artwork/${coverFilename}`;
    } else if (metadata.coverArtUrl) {
      // Fallback to cover.webp if no filename detected
      metadata.coverArtUrl = `${publicDomain}/releases/${releaseId}/artwork/cover.webp`;
    }

    // Update additional artwork URLs
    if (metadata.additionalArtwork && Array.isArray(metadata.additionalArtwork)) {
      metadata.additionalArtwork = metadata.additionalArtwork.map((url: string) => {
        const filename = url.split('/').pop();
        return `${publicDomain}/releases/${releaseId}/artwork/${filename}`;
      });
    }

    // Update track URLs
    if (metadata.tracks && Array.isArray(metadata.tracks)) {
      metadata.tracks = metadata.tracks.map((track: any) => {
        const trackNum = String(track.trackNumber + 1).padStart(2, '0');
        const trackName = track.trackName;

        return {
          ...track,
          previewUrl: `${publicDomain}/releases/${releaseId}/previews/${trackNum}-${trackName}-preview.mp3`,
          wavUrl: `${publicDomain}/releases/${releaseId}/tracks/${trackNum}-${trackName}.wav`,
          mp3Url: `${publicDomain}/releases/${releaseId}/tracks/${trackNum}-${trackName}.mp3`,
        };
      });
    }

    // Set status and timestamps
    metadata.status = 'live';
    metadata.published = true;
    metadata.publishedAt = new Date().toISOString();
    metadata.syncedAt = new Date().toISOString();

    // Write to Firebase using REST API
    await setDocument(this.config.collections.releases, releaseId, metadata);
    log.info(`✅ Release ${releaseId} synced to Firebase with status: live`);
  }

  /**
   * List releases from Firebase
   */
  async listReleases(options: any = {}): Promise<any[]> {
    const filters = [];

    if (options.status) {
      filters.push({ field: 'status', op: 'EQUAL' as const, value: options.status });
    }

    if (options.featured !== undefined) {
      filters.push({ field: 'featured', op: 'EQUAL' as const, value: options.featured });
    }

    const queryOptions: any = {
      filters: filters.length > 0 ? filters : undefined,
      limit: options.limit
    };

    if (options.orderBy) {
      queryOptions.orderBy = {
        field: options.orderBy,
        direction: (options.order || 'desc').toUpperCase() === 'DESC' ? 'DESCENDING' : 'ASCENDING'
      };
    }

    const releases = await queryCollection(this.config.collections.releases, queryOptions);
    return releases;
  }

  /**
   * Get a single release by ID
   */
  async getRelease(releaseId: string): Promise<any | null> {
    const data = await getDocument(this.config.collections.releases, releaseId);

    if (!data) {
      return null;
    }

    return data;
  }

  /**
   * Update release status
   */
  async updateReleaseStatus(releaseId: string, status: string): Promise<void> {
    await updateDocument(this.config.collections.releases, releaseId, {
      status,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Delete release (from Firebase only, R2 cleanup should be manual)
   */
  async deleteRelease(releaseId: string): Promise<void> {
    await deleteDocument(this.config.collections.releases, releaseId);
    log.info(`🗑️ Deleted release ${releaseId} from Firebase`);
  }

  /**
   * Cleanup extracted files
   */
  private cleanupExtractedFiles(extractDir: string): void {
    try {
      fs.rmSync(extractDir, { recursive: true, force: true });
      log.info(`🧹 Cleaned up: ${extractDir}`);
    } catch (error) {
      console.warn(`⚠️ Could not cleanup ${extractDir}:`, error);
    }
  }

  /**
   * List files in R2 for a release
   */
  async listR2Files(releaseId: string): Promise<string[]> {
    const command = new ListObjectsV2Command({
      Bucket: this.config.r2.bucketName,
      Prefix: `releases/${releaseId}/`,
    });

    const response = await this.r2Client.send(command);
    return response.Contents?.map(obj => obj.Key || '') || [];
  }
}