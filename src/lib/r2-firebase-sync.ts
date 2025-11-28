// src/lib/r2-firebase-sync.ts
import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import AdmZip from 'adm-zip';
import * as path from 'path';
import * as fs from 'fs';

interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicDomain: string;
}

interface FirebaseConfig {
  projectId: string;
  privateKey: string;
  clientEmail: string;
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
  private db: any;
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

    // Initialize Firebase Admin if not already initialized
    if (!getApps().length) {
      initializeApp({
        credential: cert({
          projectId: config.firebase.projectId,
          clientEmail: config.firebase.clientEmail,
          privateKey: config.firebase.privateKey.replace(/\\n/g, '\n'),
        }),
      });
    }

    this.db = getFirestore();
  }

  /**
   * Main method: Process a packaged ZIP and sync everything
   */
  async processPackageAndSync(zipPath: string): Promise<string> {
    console.log('📦 Starting package processing...');

    // Extract ZIP
    const extractDir = await this.extractZip(zipPath);
    console.log(`✅ Extracted to: ${extractDir}`);

    // Find the release directory (should be releases/RELEASE_ID/)
    const releaseDirs = fs.readdirSync(path.join(extractDir, 'releases'));
    if (releaseDirs.length === 0) {
      throw new Error('No release directory found in ZIP');
    }

    const releaseId = releaseDirs[0];
    const releaseDir = path.join(extractDir, 'releases', releaseId);
    console.log(`🎵 Processing release: ${releaseId}`);

    // Read metadata
    const metadataPath = path.join(releaseDir, 'firebase-metadata.json');
    if (!fs.existsSync(metadataPath)) {
      throw new Error('firebase-metadata.json not found in package');
    }

    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    console.log(`📄 Loaded metadata for: ${metadata.artistName} - ${metadata.releaseName}`);

    // Upload files to R2
    await this.uploadToR2(releaseId, releaseDir);
    console.log('✅ Files uploaded to R2');

    // Sync to Firebase
    await this.syncToFirebase(releaseId, metadata);
    console.log('✅ Synced to Firebase');

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
  private async uploadToR2(releaseId: string, releaseDir: string): Promise<void> {
    const uploads: Promise<void>[] = [];

    // Upload artwork
    const artworkDir = path.join(releaseDir, 'artwork');
    if (fs.existsSync(artworkDir)) {
      const artworkFiles = fs.readdirSync(artworkDir);
      for (const file of artworkFiles) {
        const filePath = path.join(artworkDir, file);
        const key = `releases/${releaseId}/artwork/${file}`;
        uploads.push(this.uploadFileToR2(filePath, key, 'image/webp'));
      }
      console.log(`📸 Queued ${artworkFiles.length} artwork files`);
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
      console.log(`🎵 Queued ${previewFiles.length} preview files`);
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
      console.log(`💿 Queued ${trackFiles.length} track files`);
    }

    // Wait for all uploads
    await Promise.all(uploads);
    console.log(`✅ All files uploaded to R2`);
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
    console.log(`  ✓ Uploaded: ${key}`);
  }

  /**
   * Sync release metadata to Firebase
   */
  private async syncToFirebase(releaseId: string, metadata: any): Promise<void> {
    // Ensure URLs use the public domain
    const publicDomain = this.config.r2.publicDomain;
    
    // Update cover art URL
    if (metadata.coverArtUrl) {
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

    // Write to Firebase
    await this.db.collection(this.config.collections.releases).doc(releaseId).set(metadata, { merge: true });
    console.log(`✅ Release ${releaseId} synced to Firebase with status: live`);
  }

  /**
   * List releases from Firebase
   */
  async listReleases(options: any = {}): Promise<any[]> {
    let query: any = this.db.collection(this.config.collections.releases);

    if (options.status) {
      query = query.where('status', '==', options.status);
    }

    if (options.featured !== undefined) {
      query = query.where('featured', '==', options.featured);
    }

    if (options.orderBy) {
      query = query.orderBy(options.orderBy, options.order || 'desc');
    }

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const snapshot = await query.get();
    const releases: any[] = [];

    snapshot.forEach((doc: any) => {
      releases.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    return releases;
  }

  /**
   * Get a single release by ID
   */
  async getRelease(releaseId: string): Promise<any | null> {
    const doc = await this.db.collection(this.config.collections.releases).doc(releaseId).get();
    
    if (!doc.exists) {
      return null;
    }

    return {
      id: doc.id,
      ...doc.data(),
    };
  }

  /**
   * Update release status
   */
  async updateReleaseStatus(releaseId: string, status: string): Promise<void> {
    await this.db.collection(this.config.collections.releases).doc(releaseId).update({
      status,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Delete release (from Firebase only, R2 cleanup should be manual)
   */
  async deleteRelease(releaseId: string): Promise<void> {
    await this.db.collection(this.config.collections.releases).doc(releaseId).delete();
    console.log(`🗑️ Deleted release ${releaseId} from Firebase`);
  }

  /**
   * Cleanup extracted files
   */
  private cleanupExtractedFiles(extractDir: string): void {
    try {
      fs.rmSync(extractDir, { recursive: true, force: true });
      console.log(`🧹 Cleaned up: ${extractDir}`);
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