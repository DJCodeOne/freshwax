// src/pages/api/update-mix-artwork.ts
// Upload new artwork for a DJ mix to R2

import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getDocument, updateDocument, verifyRequestUser } from '../../lib/firebase-rest';
import { processImageToSquareWebP } from '../../lib/image-processing';

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

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;

  const R2_CONFIG = getR2Config(env);
  const s3Client = createS3Client(R2_CONFIG);

  try {
    // SECURITY: Verify authentication via token (not cookies/form data which are spoofable)
    const { userId: currentUserId, error: authError } = await verifyRequestUser(request);
    if (!currentUserId || authError) {
      return new Response(JSON.stringify({ success: false, error: 'Authentication required' }), {
        status: 401, headers: { 'Content-Type': 'application/json' }
      });
    }

    const formData = await request.formData();
    const mixId = formData.get('mixId') as string;
    const artworkFile = formData.get('artwork') as File;

    console.log('[update-mix-artwork] Received:', {
      mixId,
      hasArtwork: !!artworkFile,
      artworkName: artworkFile?.name,
      artworkSize: artworkFile?.size,
      artworkType: artworkFile?.type,
      currentUserId
    });

    if (!mixId || !artworkFile) {
      console.log('[update-mix-artwork] Missing required fields:', { mixId: !!mixId, artworkFile: !!artworkFile });
      return new Response(JSON.stringify({
        success: false,
        error: `Missing ${!mixId ? 'mixId' : 'artwork file'}`
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log('[update-mix-artwork] Auth check:', { currentUserId });
    
    // Get the mix
    const mixData = await getDocument('dj-mixes', mixId);

    if (!mixData) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Mix not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Check ownership - allow if:
    // 1. userId matches, OR
    // 2. Mix has no userId (backfill scenario - allow if user ID is passed)
    const isOwner = mixData?.userId === currentUserId;
    const canBackfillOwnership = !mixData?.userId && currentUserId;

    console.log('[update-mix-artwork] Ownership check:', {
      mixUserId: mixData?.userId,
      currentUserId,
      isOwner,
      canBackfillOwnership
    });

    if (!isOwner && !canBackfillOwnership) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Not authorized to edit this mix'
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Validate file size (max 500KB for safety, should be under 200KB from client)
    if (artworkFile.size > 500 * 1024) {
      console.log('[update-mix-artwork] File too large:', artworkFile.size);
      return new Response(JSON.stringify({ 
        success: false, 
        error: `Artwork file too large (${Math.round(artworkFile.size / 1024)}KB, max 500KB)` 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Process artwork to WebP and upload to R2
    const timestamp = Date.now();
    const rawBuffer = await artworkFile.arrayBuffer();
    let artworkKey: string;
    let artworkBody: Buffer;
    let artworkContentType: string;

    try {
      const processed = await processImageToSquareWebP(rawBuffer, 800, 80);
      artworkKey = `dj-mixes/${mixId}/artwork-${timestamp}.webp`;
      artworkBody = Buffer.from(processed.buffer);
      artworkContentType = 'image/webp';
      console.log(`[update-mix-artwork] Processed to ${processed.width}x${processed.height} WebP`);
    } catch (imgErr) {
      console.error('[update-mix-artwork] WebP processing failed, using original:', imgErr);
      artworkKey = `dj-mixes/${mixId}/artwork-${timestamp}.webp`;
      artworkBody = Buffer.from(rawBuffer);
      artworkContentType = artworkFile.type;
    }

    await s3Client.send(new PutObjectCommand({
      Bucket: R2_CONFIG.bucketName,
      Key: artworkKey,
      Body: artworkBody,
      ContentType: artworkContentType,
      CacheControl: 'public, max-age=31536000',
    }));

    const artworkUrl = `${R2_CONFIG.publicDomain}/${artworkKey}`;

    // Update Firebase with new artwork URL (and backfill userId if missing)
    const updateData: Record<string, any> = {
      artwork_url: artworkUrl,
      artworkUrl: artworkUrl,
      imageUrl: artworkUrl,
      updatedAt: new Date().toISOString()
    };

    // Backfill userId if mix doesn't have one
    if (!mixData?.userId && currentUserId) {
      updateData.userId = currentUserId;
      console.log('[update-mix-artwork] Backfilling userId:', currentUserId);
    }

    await updateDocument('dj-mixes', mixId, updateData);
    
    console.log(`[update-mix-artwork] Updated artwork for mix ${mixId}: ${artworkUrl}`);
    
    return new Response(JSON.stringify({ 
      success: true,
      artworkUrl,
      message: 'Artwork updated successfully'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('[update-mix-artwork] Error:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Failed to update artwork' 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
