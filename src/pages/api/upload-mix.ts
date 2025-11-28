// src/pages/api/upload-mix.ts
// UPDATED: Handles genre, tracklist, duration, character limits
// Uploads DJ mixes to R2 and Firebase

import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// R2 Configuration
const R2_CONFIG = {
  accountId: import.meta.env.R2_ACCOUNT_ID,
  accessKeyId: import.meta.env.R2_ACCESS_KEY_ID,
  secretAccessKey: import.meta.env.R2_SECRET_ACCESS_KEY,
  bucketName: import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
  publicDomain: import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk',
};

// Initialize Firebase
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

const db = getFirestore();

// Initialize R2 Client
const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_CONFIG.accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_CONFIG.accessKeyId,
    secretAccessKey: R2_CONFIG.secretAccessKey,
  },
});

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

// Parse tracklist into array
function parseTracklist(tracklist: string): string[] {
  if (!tracklist || !tracklist.trim()) return [];
  
  return tracklist
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

export const POST: APIRoute = async ({ request }) => {
  try {
    console.log('=== DJ Mix Upload Started ===');
    
    const formData = await request.formData();
    
    // Get all form fields
    const audioFile = formData.get('audioFile') as File;
    const artworkFile = formData.get('artworkFile') as File | null;
    const djName = (formData.get('djName') as string || '').trim().slice(0, 15); // Max 15 chars
    const mixTitle = (formData.get('mixTitle') as string || '').trim().slice(0, 20); // Max 20 chars
    const mixDescription = (formData.get('mixDescription') as string || '').trim().slice(0, 150); // Max 150 chars (shout outs)
    const genre = (formData.get('genre') as string || 'Jungle').trim().slice(0, 30); // Max 30 chars
    const tracklistRaw = (formData.get('tracklist') as string || '').trim().slice(0, 1500); // Max 1500 chars
    const durationSecondsStr = formData.get('durationSeconds') as string || '0';
    const durationSeconds = parseInt(durationSecondsStr, 10) || 0;

    // Parse tracklist
    const tracklistArray = parseTracklist(tracklistRaw);

    console.log('Form data:', { 
      djName, 
      mixTitle,
      genre,
      durationSeconds,
      durationFormatted: formatDuration(durationSeconds),
      tracklistTracks: tracklistArray.length,
      descriptionLength: mixDescription.length,
      audioSize: audioFile?.size ? `${(audioFile.size / 1024 / 1024).toFixed(2)} MB` : 'N/A',
      hasArtwork: !!artworkFile
    });

    // Validate required fields
    if (!audioFile || !djName || !mixTitle) {
      console.error('✗ Missing required fields');
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Missing required fields (djName, mixTitle, or audioFile)' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!genre) {
      console.error('✗ Missing genre');
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Genre is required' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Generate unique ID and folder structure
    const timestamp = Date.now();
    const sanitizedDjName = djName.replace(/[^a-zA-Z0-9]/g, '_');
    const sanitizedMixTitle = mixTitle.replace(/[^a-zA-Z0-9]/g, '_');
    const mixId = `${sanitizedDjName}_${sanitizedMixTitle}_${timestamp}`;
    const folderPath = `dj-mixes/${mixId}`;

    console.log('Generated mix ID:', mixId);
    console.log('R2 folder path:', folderPath);

    // ============================================
    // UPLOAD AUDIO TO R2
    // ============================================
    console.log('📤 Uploading audio to R2...');
    
    const audioBuffer = await audioFile.arrayBuffer();
    const audioKey = `${folderPath}/audio.mp3`;
    
    await s3Client.send(
      new PutObjectCommand({
        Bucket: R2_CONFIG.bucketName,
        Key: audioKey,
        Body: Buffer.from(audioBuffer),
        ContentType: 'audio/mpeg',
        CacheControl: 'public, max-age=31536000',
      })
    );

    const audioUrl = `${R2_CONFIG.publicDomain}/${audioKey}`;
    console.log('✓ Audio uploaded:', audioUrl);

    // ============================================
    // UPLOAD ARTWORK TO R2 (or use default)
    // ============================================
    let artworkUrl: string;
    
    if (artworkFile && artworkFile.size > 0) {
      console.log('📤 Uploading artwork to R2...');
      
      const artworkBuffer = await artworkFile.arrayBuffer();
      const artworkExt = artworkFile.name.split('.').pop() || 'jpg';
      const artworkKey = `${folderPath}/artwork.${artworkExt}`;
      
      await s3Client.send(
        new PutObjectCommand({
          Bucket: R2_CONFIG.bucketName,
          Key: artworkKey,
          Body: Buffer.from(artworkBuffer),
          ContentType: artworkFile.type,
          CacheControl: 'public, max-age=31536000',
        })
      );

      artworkUrl = `${R2_CONFIG.publicDomain}/${artworkKey}`;
      console.log('✓ Artwork uploaded:', artworkUrl);
    } else {
      console.log('Using default logo for artwork');
      artworkUrl = '/logo.webp';
    }

    // ============================================
    // SAVE TO FIREBASE (dj-mixes collection)
    // ============================================
    console.log('💾 Saving to Firebase dj-mixes collection...');

    const mixData = {
      // Core identifiers
      id: mixId,
      
      // DJ & Mix info
      dj_name: djName,
      djName: djName, // Alias for compatibility
      title: mixTitle,
      mixTitle: mixTitle, // Alias
      
      // Genre
      genre: genre,
      
      // Description (Shout Outs)
      description: mixDescription,
      shoutOuts: mixDescription, // Alias
      
      // Tracklist
      tracklist: tracklistRaw, // Raw string version
      tracklistArray: tracklistArray, // Parsed array version
      trackCount: tracklistArray.length,
      
      // Duration
      durationSeconds: durationSeconds,
      durationFormatted: formatDuration(durationSeconds),
      duration: formatDuration(durationSeconds), // Alias
      
      // Media URLs
      audio_url: audioUrl,
      audioUrl: audioUrl, // Alias
      artwork_url: artworkUrl,
      artworkUrl: artworkUrl, // Alias
      
      // Upload info
      upload_date: new Date().toISOString(),
      uploadedAt: new Date().toISOString(), // Alias
      folder_path: folderPath,
      r2FolderName: mixId,
      
      // Stats
      plays: 0,
      downloads: 0,
      likes: 0,
      commentCount: 0,
      
      // Status (LIVE immediately - no approval needed)
      published: true,
      status: 'live',
      approved: true,
      
      // Storage
      storage: 'r2',
      
      // Timestamps
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Save to dj-mixes collection in Firebase
    await db.collection('dj-mixes').doc(mixId).set(mixData);
    
    console.log('✓ Saved to Firebase collection: dj-mixes');
    console.log('✓ Document ID:', mixId);
    console.log('✓ Genre:', genre);
    console.log('✓ Duration:', formatDuration(durationSeconds), `(${durationSeconds}s)`);
    console.log('✓ Tracklist tracks:', tracklistArray.length);
    console.log('✓ Status: LIVE (published immediately)');
    console.log('=== DJ Mix Upload Complete ===');

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

  } catch (error) {
    console.error('=== Upload Error ===');
    console.error(error);
    
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to upload mix',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};