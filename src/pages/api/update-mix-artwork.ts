// src/pages/api/update-mix-artwork.ts
// Upload new artwork for a DJ mix to R2

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

export const POST: APIRoute = async ({ request, cookies }) => {
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
    const mixRef = db.collection('dj-mixes').doc(mixId);
    const mixDoc = await mixRef.get();
    
    if (!mixDoc.exists) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Mix not found' 
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const mixData = mixDoc.data();
    
    // Check ownership - allow if userId matches
    const isOwner = mixData?.userId === currentUserId;
    
    // Also check by artist name if partnerId is set
    if (!isOwner && partnerId) {
      const partnerDoc = await db.collection('artists').doc(partnerId).get();
      const partnerName = partnerDoc.exists ? partnerDoc.data()?.artistName?.toLowerCase().trim() : null;
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
    await mixRef.update({
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
