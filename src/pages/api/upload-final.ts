import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import AdmZip from 'adm-zip';

//============================================================================
// CONFIGURATION
//============================================================================

const R2_CONFIG = {
  accountId: import.meta.env.R2_ACCOUNT_ID,
  accessKeyId: import.meta.env.R2_ACCESS_KEY_ID,
  secretAccessKey: import.meta.env.R2_SECRET_ACCESS_KEY,
  bucketName: import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
  publicDomain: import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk',
};

// Initialize Firebase Admin (only once)
function getFirebaseDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: import.meta.env.FIREBASE_PROJECT_ID,
        privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      }),
    });
  }
  return getFirestore();
}

const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_CONFIG.accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_CONFIG.accessKeyId,
    secretAccessKey: R2_CONFIG.secretAccessKey,
  },
});

//============================================================================
// HELPER: CREATE FOLDER NAME FROM METADATA
//============================================================================

function createFolderName(metadata: any): string {
  const artist = (metadata.artistName || 'Unknown-Artist')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase();
  
  const release = (metadata.releaseName || 'Untitled')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase();
  
  const catalog = (metadata.labelCode || metadata.catalogNumber || '')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .toLowerCase();
  
  let folderName = `${artist}_${release}`;
  
  if (catalog) {
    folderName += `_${catalog}`;
  }
  
  const timestamp = Date.now();
  folderName += `_${timestamp}`;
  
  return folderName;
}

//============================================================================
// API HANDLER
//============================================================================

export const POST: APIRoute = async ({ request }) => {
  try {
    console.log('📦 Received upload request');
    
    const db = getFirebaseDb();
    
    const formData = await request.formData();
    const packageFile = formData.get('package') as File;
    const releaseId = formData.get('releaseId') as string;
    
    if (!packageFile || !releaseId) {
      return new Response(JSON.stringify({ 
        error: 'Missing package or release ID' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    console.log(`✓ Release ID: ${releaseId}`);
    console.log(`✓ Package size: ${(packageFile.size / 1024 / 1024).toFixed(2)} MB`);
    
    const arrayBuffer = await packageFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    console.log('📦 Extracting ZIP package...');
    const zip = new AdmZip(buffer);
    const zipEntries = zip.getEntries();
    
    console.log('📋 ZIP Contents:');
    zipEntries.forEach(entry => {
      if (!entry.isDirectory) {
        console.log(`  - ${entry.entryName}`);
      }
    });
    
    // STEP 1: Find metadata JSON to get release info
    let metadata: any = null;
    for (const entry of zipEntries) {
      if (entry.isDirectory) continue;
      const entryPath = entry.entryName;
      
      if (entryPath.endsWith('firebase-metadata.json') || 
          (entryPath.endsWith('.json') && entryPath.includes('metadata'))) {
        const content = entry.getData().toString('utf8');
        metadata = JSON.parse(content);
        console.log('✓ Found metadata:', metadata.artistName, '-', metadata.releaseName);
        break;
      }
    }
    
    if (!metadata) {
      return new Response(JSON.stringify({ 
        error: 'No metadata JSON found in package' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // CREATE ORGANIZED FOLDER NAME
    const folderName = createFolderName(metadata);
    console.log(`📁 NEW Folder name: ${folderName}`);
    
    // STEP 2: Extract the actual releaseId from the ZIP structure
    let zipReleaseId = releaseId;
    const firstEntry = zipEntries.find(e => !e.isDirectory && e.entryName.startsWith('releases/'));
    if (firstEntry) {
      const pathParts = firstEntry.entryName.split('/');
      if (pathParts.length >= 2) {
        zipReleaseId = pathParts[1];
        console.log(`📁 OLD ZIP release folder: ${zipReleaseId}`);
      }
    }
    
    console.log('☁️  Uploading files to R2 with NEW folder structure...');
    console.log(`📁 TARGET FOLDER: releases/${folderName}/`);
    
    // Track uploaded files by category for URL mapping
    const uploadedFiles = {
      artwork: [] as Array<{ filename: string; url: string; type: string }>,
      previews: [] as Array<{ filename: string; url: string; trackNumber: number }>,
      tracks: [] as Array<{ filename: string; url: string; trackNumber: number; format: string }>,
      metadata: [] as Array<{ filename: string; url: string }>,
    };
    
    let filesUploaded = 0;
    
    for (const entry of zipEntries) {
      if (entry.isDirectory) continue;
      
      const entryPath = entry.entryName;
      
      // Only process files in the releases folder
      if (!entryPath.startsWith('releases/')) {
        console.log(`⚠️ Skipping: ${entryPath} (not in releases folder)`);
        continue;
      }
      
      // Split the path to extract components
      // Example: "releases/OldFolder_123456/artwork/cover.webp"
      const pathParts = entryPath.split('/');
      
      // pathParts[0] = "releases"
      // pathParts[1] = "OldFolder_123456" (the old release folder)
      // pathParts[2+] = "artwork/cover.webp" or "tracks/01-track.mp3"
      
      if (pathParts.length < 3) {
        console.log(`⚠️ Skipping: ${entryPath} (invalid path structure)`);
        continue;
      }
      
      // Get everything after "releases/{oldFolder}/"
      // Join pathParts[2] onwards to get "artwork/cover.webp" or "tracks/01-track.mp3"
      const relativePath = pathParts.slice(2).join('/');
      
      if (!relativePath) {
        console.log(`⚠️ Skipping: ${entryPath} (empty relative path)`);
        continue;
      }
      
      const fileContent = entry.getData();
      const contentType = getContentType(entryPath);
      
      // Build the NEW key with the new folder name
      const newKey = `releases/${folderName}/${relativePath}`;
      
      await uploadToR2(newKey, fileContent, contentType);
      
      const publicUrl = `${R2_CONFIG.publicDomain}/${newKey}`;
      
      // Categorize uploaded files
      const filename = relativePath.split('/').pop() || '';
      
      if (relativePath.startsWith('artwork/')) {
        const type = filename.includes('cover') ? 'cover' : 'additional';
        uploadedFiles.artwork.push({ filename, url: publicUrl, type });
      } else if (relativePath.startsWith('previews/')) {
        const trackNum = extractTrackNumber(filename);
        uploadedFiles.previews.push({ filename, url: publicUrl, trackNumber: trackNum });
      } else if (relativePath.startsWith('tracks/')) {
        const trackNum = extractTrackNumber(filename);
        const format = filename.toLowerCase().endsWith('.wav') ? 'wav' : 'mp3';
        uploadedFiles.tracks.push({ filename, url: publicUrl, trackNumber: trackNum, format });
      } else if (filename.endsWith('.json')) {
        uploadedFiles.metadata.push({ filename, url: publicUrl });
      }
      
      filesUploaded++;
      console.log(`✓ Uploaded ${filesUploaded}: ${newKey}`);
    }
    
    console.log(`✅ Uploaded ${filesUploaded} files to R2`);
    console.log(`📊 Artwork: ${uploadedFiles.artwork.length}, Previews: ${uploadedFiles.previews.length}, Tracks: ${uploadedFiles.tracks.length}`);
    
    console.log('🔗 Building metadata with NEW R2 URLs...');
    const updatedMetadata = buildMetadataWithUrls(metadata, uploadedFiles, folderName);
    
    console.log('==========================================');
    console.log('🔥 FIREBASE SYNC STARTING');
    console.log('==========================================');
    console.log('Document ID:', zipReleaseId);
    console.log('Artist:', updatedMetadata.artistName);
    console.log('Release:', updatedMetadata.releaseName);
    console.log('Cover Art URL:', updatedMetadata.coverArtUrl);
    console.log('Track Count:', updatedMetadata.tracks?.length || 0);
    console.log('R2 Folder:', updatedMetadata.r2FolderName);
    console.log('==========================================');

    try {
      await syncToFirebase(db, zipReleaseId, updatedMetadata);
      console.log('✅ syncToFirebase() completed without error');
      
      // VERIFY the document exists
      console.log('🔍 Verifying document in Firebase...');
      const verifyRef = db.collection('releases').doc(zipReleaseId);
      const verifyDoc = await verifyRef.get();
      
      if (verifyDoc.exists) {
        const docData = verifyDoc.data();
        console.log('✅✅✅ VERIFICATION SUCCESS ✅✅✅');
        console.log('Document ID:', verifyDoc.id);
        console.log('Artist Name:', docData?.artistName);
        console.log('Release Name:', docData?.releaseName);
        console.log('Status:', docData?.status);
        console.log('Cover Art:', docData?.coverArtUrl);
      } else {
        console.error('❌❌❌ VERIFICATION FAILED ❌❌❌');
        console.error('Document does NOT exist in Firebase after write!');
        console.error('Document ID attempted:', zipReleaseId);
        console.error('Collection: releases');
      }
      
    } catch (fbError) {
      console.error('==========================================');
      console.error('❌ FIREBASE SYNC ERROR');
      console.error('==========================================');
      console.error('Error:', fbError);
      console.error('Message:', fbError instanceof Error ? fbError.message : 'Unknown error');
      console.error('Stack:', fbError instanceof Error ? fbError.stack : 'No stack trace');
      console.error('==========================================');
      throw new Error(`Firebase sync failed: ${fbError instanceof Error ? fbError.message : 'Unknown error'}`);
    }

    console.log('==========================================');
    console.log('✅ Process complete!');
    console.log('==========================================');
    
    return new Response(JSON.stringify({
      success: true,
      releaseId: zipReleaseId,
      folderName: folderName,
      artistName: metadata.artistName || 'Unknown',
      releaseName: metadata.releaseName || 'Untitled',
      filesUploaded: filesUploaded,
      firebaseUpdated: true,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('❌ Upload failed:', error);
    
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Upload failed',
      details: error instanceof Error ? error.stack : String(error),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

//============================================================================
// HELPER FUNCTIONS
//============================================================================

async function uploadToR2(
  key: string,
  content: Buffer,
  contentType: string
): Promise<void> {
  const command = new PutObjectCommand({
    Bucket: R2_CONFIG.bucketName,
    Key: key,
    Body: content,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000',
  });
  
  await s3Client.send(command);
}

function getContentType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop();
  
  const types: Record<string, string> = {
    'webp': 'image/webp',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'json': 'application/json',
    'txt': 'text/plain',
  };
  
  return types[ext || ''] || 'application/octet-stream';
}

function extractTrackNumber(filename: string): number {
  const match = filename.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) - 1 : 0;
}

function buildMetadataWithUrls(
  metadata: any,
  uploadedFiles: any,
  folderName: string
): any {
  const updated = { ...metadata };
  
  updated.r2FolderName = folderName;
  
  // Update artwork URLs
  const coverArt = uploadedFiles.artwork.find((a: any) => a.type === 'cover');
  if (coverArt) {
    updated.coverArtUrl = coverArt.url;
    updated.artworkUrl = coverArt.url;
  }
  
  const additionalArtwork = uploadedFiles.artwork
    .filter((a: any) => a.type !== 'cover')
    .map((a: any) => a.url);
  
  updated.artwork = {
    cover: coverArt?.url || null,
    additional: additionalArtwork,
  };
  
  updated.additionalArtwork = additionalArtwork;
  
  console.log('🎵 Building tracks array from uploaded files...');
  console.log('   Uploaded tracks:', uploadedFiles.tracks.length);
  console.log('   Uploaded previews:', uploadedFiles.previews.length);
  
  // BUILD TRACKS ARRAY from uploaded files
  const tracksByNumber = new Map();
  
  // Process all uploaded track files
  uploadedFiles.tracks.forEach((trackFile: any) => {
    const trackNum = trackFile.trackNumber;
    if (!tracksByNumber.has(trackNum)) {
      tracksByNumber.set(trackNum, {
        trackNumber: trackNum + 1,
        displayTrackNumber: trackNum + 1,
      });
    }
    
    const track = tracksByNumber.get(trackNum);
    if (trackFile.format === 'wav') {
      track.wavUrl = trackFile.url;
    } else if (trackFile.format === 'mp3') {
      track.mp3Url = trackFile.url;
      track.url = trackFile.url;
    }
  });
  
  // Add preview URLs
  uploadedFiles.previews.forEach((previewFile: any) => {
    const trackNum = previewFile.trackNumber;
    if (!tracksByNumber.has(trackNum)) {
      tracksByNumber.set(trackNum, {
        trackNumber: trackNum + 1,
        displayTrackNumber: trackNum + 1,
      });
    }
    
    const track = tracksByNumber.get(trackNum);
    track.previewUrl = previewFile.url;
    track.preview_url = previewFile.url;
  });
  
  // Convert map to array and sort
  const tracksArray = Array.from(tracksByNumber.values()).sort((a, b) => a.trackNumber - b.trackNumber);
  
  // Add track metadata from trackListingJSON
  if (metadata.trackListingJSON) {
    try {
      const trackMetadata = JSON.parse(metadata.trackListingJSON);
      console.log('   Found track metadata:', trackMetadata.length, 'tracks');
      
      tracksArray.forEach((track, index) => {
        const metadataTrack = trackMetadata[index];
        if (metadataTrack) {
          // Basic track info
          track.trackName = metadataTrack.trackName || metadataTrack.title || `Track ${track.trackNumber}`;
          
          // Duration
          track.duration = metadataTrack.duration || metadataTrack.trackDuration || '';
          track.trackDuration = metadataTrack.duration || metadataTrack.trackDuration || '';
          
          // Musical metadata
          track.key = metadataTrack.key || '--';
          track.bpm = metadataTrack.bpm || '';
          
          // ISRC codes (handle both field names)
          track.isrc = metadataTrack.trackISRC || metadataTrack.isrc || '';
          track.trackISRC = metadataTrack.trackISRC || metadataTrack.isrc || '';
          
          // Featured artists & remixers
          track.featured = metadataTrack.featured || '';
          track.featuredArtist = metadataTrack.featured || '';
          track.remixer = metadataTrack.remixer || '';
          
        } else {
          track.trackName = `Track ${track.trackNumber}`;
          track.key = '--';
        }
      });
    } catch (e) {
      console.error('Failed to parse trackListingJSON:', e);
      // Fallback to trackListing string
      if (metadata.trackListing && typeof metadata.trackListing === 'string') {
        const trackNames = metadata.trackListing.split('\n').map((name: string) => name.trim()).filter((name: string) => name);
        console.log('   Using trackListing fallback:', trackNames);
        
        tracksArray.forEach((track, index) => {
          track.trackName = trackNames[index] || `Track ${track.trackNumber}`;
          track.key = '--';
        });
      }
    }
  } else if (metadata.trackListing && typeof metadata.trackListing === 'string') {
    // No JSON, use plain text listing
    const trackNames = metadata.trackListing.split('\n').map((name: string) => name.trim()).filter((name: string) => name);
    console.log('   Found track names in trackListing:', trackNames);
    
    tracksArray.forEach((track, index) => {
      track.trackName = trackNames[index] || `Track ${track.trackNumber}`;
      track.key = '--';
    });
  } else {
    // No metadata - use generic names
    tracksArray.forEach((track) => {
      track.trackName = `Track ${track.trackNumber}`;
      track.key = '--';
    });
  }
  
  updated.tracks = tracksArray;
  
  console.log('✅ Built tracks array:', tracksArray.length, 'tracks');
  tracksArray.forEach((track) => {
    console.log(`   ${track.trackNumber}. ${track.trackName}`);
    console.log(`      Preview: ${track.previewUrl ? '✓' : '✗'}`);
    console.log(`      MP3: ${track.mp3Url ? '✓' : '✗'}`);
    console.log(`      WAV: ${track.wavUrl ? '✓' : '✗'}`);
    if (track.featured) console.log(`      Featured: ${track.featured}`);
    if (track.remixer) console.log(`      Remixer: ${track.remixer}`);
    if (track.key && track.key !== '--') console.log(`      Key: ${track.key}`);
    if (track.bpm) console.log(`      BPM: ${track.bpm}`);
  });
  
  // Ensure all other metadata fields are preserved
  // These come from the form but need to be explicitly kept
  updated.labelName = metadata.labelName || '';
  updated.releaseDescription = metadata.releaseDescription || metadata.notes || '';
  updated.notes = metadata.notes || metadata.releaseDescription || '';
  
  // Stats initialization
  updated.stats = {
    totalTracks: tracksArray.length,
    totalPreviews: uploadedFiles.previews.length,
    totalArtwork: additionalArtwork.length,
    hasCoverArt: !!coverArt,
    plays: 0,
    downloads: 0,
    views: 0,
  };
  
  return updated;
}

async function syncToFirebase(db: FirebaseFirestore.Firestore, releaseId: string, metadata: any): Promise<void> {
  console.log('[syncToFirebase] Building release document...');
  
  const releaseDoc = {
    id: releaseId,
    r2FolderName: metadata.r2FolderName,
    
    artistName: metadata.artistName || 'Unknown',
    releaseName: metadata.releaseName || 'Untitled',
    labelName: metadata.labelName || null,
    labelCode: metadata.labelCode || null,
    genre: metadata.customGenre || metadata.genre || 'Electronic',
    releaseType: metadata.releaseType || 'EP',
    
    releaseDate: metadata.releaseDate || new Date().toISOString().split('T')[0],
    officialReleaseDate: metadata.officialReleaseDate || null,
    uploadedAt: metadata.uploadedAt || new Date().toISOString(),
    processedAt: new Date().toISOString(),
    
    pricing: {
      digital: parseFloat(metadata.pricePerSale || '0'),
      track: parseFloat(metadata.trackPrice || '1.00'),
      vinyl: metadata.vinylPrice ? parseFloat(metadata.vinylPrice) : null,
    },
    pricePerSale: parseFloat(metadata.pricePerSale || '0'),
    trackPrice: parseFloat(metadata.trackPrice || '1.00'),
    vinylPrice: metadata.vinylPrice ? parseFloat(metadata.vinylPrice) : null,
    
    vinylRelease: metadata.vinylRelease || false,
    vinylRecordCount: metadata.vinylRecordCount || null,
    vinylRPM: metadata.vinylRPM || null,
    vinylSize: metadata.vinylSize || null,
    vinylWeight: metadata.vinylWeight || null,
    pressingPlant: metadata.pressingPlant || null,
    expectedShippingDate: metadata.expectedShippingDate || null,
    hasLimitedEdition: metadata.hasLimitedEdition || false,
    limitedEditionType: metadata.limitedEditionType || null,
    limitedEditionDetails: metadata.limitedEditionDetails || null,
    vinyl: metadata.vinylRelease ? {
      available: true,
      recordCount: parseInt(metadata.vinylRecordCount || '1'),
      price: parseFloat(metadata.vinylPrice || '0'),
      rpm: metadata.vinylRPM || null,
      size: metadata.vinylSize || null,
      weight: metadata.vinylWeight || null,
      pressingPlant: metadata.pressingPlant || null,
      expectedShippingDate: metadata.expectedShippingDate || null,
      limitedEdition: metadata.hasLimitedEdition ? {
        type: metadata.limitedEditionType || null,
        details: metadata.limitedEditionDetails || null,
      } : null,
    } : null,
    
    masteredBy: metadata.masteredBy || null,
    recordingLocation: metadata.recordingLocation || null,
    recordingYear: metadata.recordingYear || null,
    
    copyrightYear: metadata.copyrightYear || new Date().getFullYear(),
    copyrightHolder: metadata.copyrightHolder || null,
    publishingRights: metadata.publishingRights || null,
    publishingCompany: metadata.publishingCompany || null,
    upcEanCode: metadata.upcEanCode || null,
    
    isPreviouslyReleased: metadata.isPreviouslyReleased || false,
    originalReleaseDate: metadata.originalReleaseDate || null,
    hasPreOrder: metadata.hasPreOrder || false,
    preOrderDate: metadata.preOrderDate || null,
    hasExplicitContent: metadata.hasExplicitContent || false,
    primaryLanguage: metadata.primaryLanguage || 'English',
    
    releaseDescription: metadata.releaseDescription || null,
    
    coverArtUrl: metadata.coverArtUrl || null,
    artworkUrl: metadata.coverArtUrl || null,
    artwork: metadata.artwork || {
      cover: null,
      additional: [],
    },
    
    tracks: metadata.tracks || [],
    
    trackListing: metadata.trackListing || [],
    
    submittedBy: metadata.submittedBy || null,
    email: metadata.email || null,
    
    socialLinks: metadata.socialLinks || {},
    
    status: 'pending',
    approved: false,
    published: false,
    featured: false,
    
    stats: metadata.stats || {
      totalTracks: metadata.tracks?.length || 0,
      totalPreviews: 0,
      totalArtwork: 0,
      hasCoverArt: !!metadata.coverArtUrl,
      plays: 0,
      downloads: 0,
      views: 0,
    },
    
    metadata: {
      submittedBy: metadata.submittedBy || null,
      email: metadata.email || null,
      notes: metadata.notes || null,
      officialReleaseDate: metadata.officialReleaseDate || null,
    },
    
    ratings: {
      average: 0,
      count: 0,
      total: 0,
      fiveStarCount: 0,
    },
    ratingsAverage: 0,
    ratingsCount: 0,
    fiveStarCount: 0,
    overallRating: {
      average: 0,
      count: 0,
      total: 0,
    },
    comments: [],
    
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  
  console.log('[syncToFirebase] Document structure prepared');
  console.log('[syncToFirebase] Document ID:', releaseId);
  console.log('[syncToFirebase] Artist:', releaseDoc.artistName);
  console.log('[syncToFirebase] Release:', releaseDoc.releaseName);
  console.log('[syncToFirebase] Status:', releaseDoc.status);
  console.log('[syncToFirebase] Cover Art URL:', releaseDoc.coverArtUrl);
  
  try {
    const releaseRef = db.collection('releases').doc(releaseId);
    console.log('[syncToFirebase] Writing to Firestore...');
    console.log('[syncToFirebase] Collection: releases');
    console.log('[syncToFirebase] Document ID:', releaseId);
    
    await releaseRef.set(releaseDoc);
    
    console.log('[syncToFirebase] ✅ SUCCESS - Document written to Firestore');
    console.log('[syncToFirebase] Document path: releases/' + releaseId);
    
  } catch (error) {
    console.error('[syncToFirebase] ❌ FAILED to write to Firestore:', error);
    console.error('[syncToFirebase] Error details:', error instanceof Error ? error.message : 'Unknown error');
    console.error('[syncToFirebase] Error stack:', error instanceof Error ? error.stack : 'No stack');
    throw error;
  }
}