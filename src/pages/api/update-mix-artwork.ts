// src/pages/api/update-mix-artwork.ts
// Upload new artwork for a DJ mix to R2

import type { APIRoute } from 'astro';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getDocument, updateDocument, initFirebaseEnv } from '../../lib/firebase-rest';

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

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  // Initialize for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  const R2_CONFIG = getR2Config(env);
  const s3Client = createS3Client(R2_CONFIG);

  try {
    const formData = await request.formData();
    const mixId = formData.get('mixId') as string;
    const artworkFile = formData.get('artwork') as File;
    const userIdFromForm = formData.get('userId') as string;
    
    console.log('[update-mix-artwork] Received:', { 
      mixId, 
      hasArtwork: !!artworkFile, 
      artworkName: artworkFile?.name,
      artworkSize: artworkFile?.size,
      artworkType: artworkFile?.type,
      userIdFromForm 
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
    
    // Get user ID from cookies or form data
    const partnerId = cookies.get('partnerId')?.value || '';
    const customerId = cookies.get('customerId')?.value || '';
    const firebaseUid = cookies.get('firebaseUid')?.value || '';
    const currentUserId = partnerId || customerId || firebaseUid || userIdFromForm;
    
    console.log('[update-mix-artwork] Auth check:', { partnerId, customerId, firebaseUid, userIdFromForm, currentUserId });
    
    if (!currentUserId) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Not authenticated' 
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
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
    
    // Check ownership - allow if userId matches
    const isOwner = mixData?.userId === currentUserId;
    
    // Also check by artist name if partnerId is set
    if (!isOwner && partnerId) {
      const partnerData = await getDocument('artists', partnerId);
      const partnerName = partnerData?.artistName?.toLowerCase().trim() || null;
      const mixDjName = (mixData?.djName || mixData?.dj_name || '').toLowerCase().trim();
      
      if (partnerName && mixDjName === partnerName) {
        // Owner via artist name match
      } else {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Not authorized to edit this mix' 
        }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    } else if (!isOwner) {
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
    
    // Upload to R2
    const timestamp = Date.now();
    const artworkKey = `dj-mixes/${mixId}/artwork-${timestamp}.webp`;
    const artworkBuffer = Buffer.from(await artworkFile.arrayBuffer());
    
    await s3Client.send(new PutObjectCommand({
      Bucket: R2_CONFIG.bucketName,
      Key: artworkKey,
      Body: artworkBuffer,
      ContentType: 'image/webp',
      CacheControl: 'public, max-age=31536000',
    }));
    
    const artworkUrl = `${R2_CONFIG.publicDomain}/${artworkKey}`;

    // Update Firebase with new artwork URL
    await updateDocument('dj-mixes', mixId, {
      artwork_url: artworkUrl,
      artworkUrl: artworkUrl,
      imageUrl: artworkUrl,
      updatedAt: new Date().toISOString()
    });
    
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
