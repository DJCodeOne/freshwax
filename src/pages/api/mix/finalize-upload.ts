// src/pages/api/mix/finalize-upload.ts
// Finalizes a DJ mix upload after direct R2 upload completes
// Saves metadata to Firebase

import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getDocument, setDocument, verifyRequestUser, invalidateMixesCache } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { d1UpsertMix } from '../../../lib/d1-catalog';
import { processImageToSquareWebP } from '../../../lib/image-processing';

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

export const prerender = false;

// Parse tracklist into array
function parseTracklist(tracklist: string): string[] {
  if (!tracklist || !tracklist.trim()) return [];
  return tracklist.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      return line.replace(/^\d+[\.\)\:\-]?\s*[-–—]?\s*/, '').trim();
    })
    .filter(line => line.length > 0);
}

// Max JSON body size for metadata-only requests: 1MB
const MAX_FINALIZE_BODY_SIZE = 1 * 1024 * 1024;

export const POST: APIRoute = async ({ request, locals }) => {
  // Reject oversized JSON bodies before reading into memory
  const reqContentLength = parseInt(request.headers.get('Content-Length') || '0');
  if (reqContentLength > MAX_FINALIZE_BODY_SIZE) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Request body too large. Maximum 1MB for metadata.'
    }), { status: 413, headers: { 'Content-Type': 'application/json' } });
  }

  // Rate limit: upload operations - 10 per hour
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`finalize-mix:${clientId}`, RateLimiters.upload);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;


  // Require authenticated user
  const { userId: verifiedUserId, error: authError } = await verifyRequestUser(request);
  if (authError || !verifiedUserId) {
    return new Response(JSON.stringify({
      success: false,
      error: authError || 'Authentication required'
    }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const body = await request.json();
    const {
      mixId,
      audioUrl,
      artworkUrl,
      folderPath,
      djName,
      mixTitle,
      mixDescription,
      genre,
      tracklist,
      durationSeconds,
      userId,
    } = body;

    // Verify the authenticated user matches the claimed userId
    if (userId && userId !== verifiedUserId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User ID mismatch - you can only finalize uploads for your own account'
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    if (!mixId || !audioUrl) {
      return new Response(JSON.stringify({
        success: false,
        error: 'mixId and audioUrl are required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // CRITICAL: Verify the audio file actually exists in R2 before saving metadata
    // This prevents orphaned mix entries when uploads fail or are cancelled
    try {
      console.log(`[finalize-upload] Verifying audio file exists: ${audioUrl}`);
      const verifyResponse = await fetch(audioUrl, { method: 'HEAD' });

      if (!verifyResponse.ok) {
        console.error(`[finalize-upload] Audio file not found: ${audioUrl} (status: ${verifyResponse.status})`);
        return new Response(JSON.stringify({
          success: false,
          error: 'Audio file upload incomplete or failed. Please try uploading again.'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Also check file has content (not empty)
      const contentLength = verifyResponse.headers.get('content-length');
      if (!contentLength || parseInt(contentLength) < 1000) {
        console.error(`[finalize-upload] Audio file too small or empty: ${contentLength} bytes`);
        return new Response(JSON.stringify({
          success: false,
          error: 'Audio file appears to be empty or incomplete. Please try uploading again.'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      console.log(`[finalize-upload] Audio file verified: ${contentLength} bytes`);
    } catch (verifyError) {
      console.error(`[finalize-upload] Failed to verify audio file:`, verifyError);
      return new Response(JSON.stringify({
        success: false,
        error: 'Could not verify audio file. Please try uploading again.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Use verified userId from auth token (not the untrusted body value)
    const authenticatedUserId = verifiedUserId;

    // Get user's display name from profile
    let displayName = djName || 'Unknown DJ';
    if (authenticatedUserId) {
      try {
        const userData = await getDocument('users', authenticatedUserId);
        if (userData?.displayName) {
          displayName = userData.displayName;
        }
      } catch (e) {
        console.log('[finalize-upload] Could not fetch user data, using provided name');
      }
    }

    const uploadDate = new Date().toISOString();
    const tracklistArray = parseTracklist(tracklist || '');

    // Process artwork to WebP if provided
    let finalArtworkUrl = artworkUrl || '/place-holder.webp';
    let finalThumbUrl: string | undefined;
    if (artworkUrl && !artworkUrl.includes('place-holder')) {
      try {
        const R2_CONFIG = getR2Config(env);
        const s3Client = createS3Client(R2_CONFIG);

        const artworkResp = await fetch(artworkUrl);
        if (artworkResp.ok) {
          const artworkBuffer = await artworkResp.arrayBuffer();
          const processed = await processImageToSquareWebP(artworkBuffer, 800, 80);
          const webpKey = `dj-mixes/${mixId}/artwork.webp`;

          await s3Client.send(new PutObjectCommand({
            Bucket: R2_CONFIG.bucketName,
            Key: webpKey,
            Body: Buffer.from(processed.buffer),
            ContentType: 'image/webp',
            CacheControl: 'public, max-age=31536000',
          }));

          finalArtworkUrl = `${R2_CONFIG.publicDomain}/${webpKey}`;
          console.log(`[finalize-upload] Artwork processed to ${processed.width}x${processed.height} WebP`);

          // Generate 400x400 thumbnail for listing pages
          try {
            const thumb = await processImageToSquareWebP(artworkBuffer, 400, 75);
            const thumbKey = `dj-mixes/${mixId}/thumb.webp`;

            await s3Client.send(new PutObjectCommand({
              Bucket: R2_CONFIG.bucketName,
              Key: thumbKey,
              Body: Buffer.from(thumb.buffer),
              ContentType: 'image/webp',
              CacheControl: 'public, max-age=31536000',
            }));

            finalThumbUrl = `${R2_CONFIG.publicDomain}/${thumbKey}`;
            console.log(`[finalize-upload] Thumbnail generated: ${thumb.width}x${thumb.height} WebP`);
          } catch (thumbErr) {
            console.error('[finalize-upload] Thumbnail generation failed (non-critical):', thumbErr);
          }
        }
      } catch (imgErr) {
        console.error('[finalize-upload] WebP processing failed, using original:', imgErr);
      }
    }

    // Save mix metadata to Firebase
    const mixData = {
      id: mixId,
      title: (mixTitle || 'Untitled Mix').slice(0, 50),
      name: (mixTitle || 'Untitled Mix').slice(0, 50),
      djName: displayName.slice(0, 30),
      dj_name: displayName.slice(0, 30),
      displayName: displayName.slice(0, 30),
      description: (mixDescription || '').slice(0, 150),
      shoutOuts: (mixDescription || '').slice(0, 150),
      genre: (genre || 'Jungle').slice(0, 30),
      tracklist: tracklist || '',
      tracklistArray,
      trackCount: tracklistArray.length,
      durationSeconds: durationSeconds || 0,
      durationFormatted: formatDuration(durationSeconds || 0),
      duration: formatDuration(durationSeconds || 0),
      audio_url: audioUrl,
      audioUrl: audioUrl,
      mp3Url: audioUrl,
      artworkUrl: finalArtworkUrl,
      imageUrl: finalArtworkUrl,
      artwork_url: finalArtworkUrl,
      ...(finalThumbUrl && { thumbUrl: finalThumbUrl }),
      folder_path: folderPath,
      userId: authenticatedUserId,
      upload_date: uploadDate,
      uploadedAt: uploadDate,
      createdAt: uploadDate,
      updatedAt: uploadDate,
      published: true,
      allowDownload: true,
      featured: false,
      plays: 0,
      likes: 0,
      downloads: 0,
      playCount: 0,
      likeCount: 0,
      downloadCount: 0,
      commentCount: 0,
      comments: [],
      ratings: { average: 0, count: 0 },
    };

    // Write to Firebase first (primary)
    await setDocument('dj-mixes', mixId, mixData);
    console.log(`[finalize-upload] Mix saved to Firebase: ${mixId}`);

    // Dual-write to D1 (secondary, non-blocking)
    const db = env?.DB;
    if (db) {
      try {
        await d1UpsertMix(db, mixId, mixData);
        console.log(`[finalize-upload] Mix also written to D1: ${mixId}`);
      } catch (d1Error) {
        // Log D1 error but don't fail the request
        console.error('[finalize-upload] D1 dual-write failed (non-critical):', d1Error);
      }
    }

    // Clear cache so new mix appears immediately
    invalidateMixesCache();

    return new Response(JSON.stringify({
      success: true,
      mixId,
      message: 'Mix uploaded successfully'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[finalize-upload] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

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
