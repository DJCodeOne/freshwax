// src/pages/api/upload-mix.ts
// Uploads DJ mixes to R2 and Firebase with production-ready logging

import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getDocument, setDocument, initFirebaseEnv } from '../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../lib/rate-limit';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

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

export const POST: APIRoute = async ({ request, locals }) => {
  // Rate limit: upload operations - 10 per hour
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`upload-mix:${clientId}`, RateLimiters.upload);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  // Initialize R2/S3 client for Cloudflare runtime
  const R2_CONFIG = getR2Config(env);
  const s3Client = createS3Client(R2_CONFIG);

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
    
    // Fetch the user's preferred displayName from their profile
    let displayName = djNameFromForm;
    if (userId) {
      try {
        // Check customers collection first (preferred display name)
        let userData = await getDocument('customers', userId);
        if (userData?.displayName) {
          displayName = userData.displayName;
          log.info(`[upload-mix] Using displayName from customers: ${displayName}`);
        } else {
          // Fallback to users collection
          userData = await getDocument('users', userId);
          if (userData) {
            displayName = userData.displayName || userData.partnerInfo?.displayName || djNameFromForm;
            log.info(`[upload-mix] Using displayName from users: ${displayName}`);
          }
        }
      } catch (e) {
        log.info(`[upload-mix] Could not fetch displayName, using form value: ${djNameFromForm}`);
      }
    }
    
    // Use displayName for public display, keep original for reference
    const djName = displayName;

    const tracklistArray = parseTracklist(tracklistRaw);

    // Validate required fields
    if (!audioFile || !djName || !mixTitle || !genre) {
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Missing required fields (djName, mixTitle, genre, or audioFile)' 
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

    log.info(`[upload-mix] Uploading: ${djName} - ${mixTitle} (${(audioFile.size / 1024 / 1024).toFixed(2)} MB)`);

    // Upload audio to R2
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

    // Upload artwork to R2 (or use default)
    let artworkUrl: string;
    
    if (artworkFile && artworkFile.size > 0) {
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
    } else {
      artworkUrl = '/place-holder.webp';
    }

    // Save to Firebase
    const mixData = {
      id: mixId,
      userId: userId,
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

    log.info(`[upload-mix] Success: ${mixId} (${genre}, ${formatDuration(durationSeconds)}, ${tracklistArray.length} tracks)`);

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
    log.error('[upload-mix] Error:', error);
    
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