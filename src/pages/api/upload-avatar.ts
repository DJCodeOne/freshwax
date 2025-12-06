// src/pages/api/upload-avatar.ts
// Upload user avatar to R2 - compressed to small WebP for icon use

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

// R2 client
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${import.meta.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: import.meta.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: import.meta.env.R2_SECRET_ACCESS_KEY || '',
  },
});

const R2_BUCKET = import.meta.env.R2_BUCKET_NAME || 'freshwax';
const R2_PUBLIC_URL = import.meta.env.R2_PUBLIC_URL || 'https://cdn.freshwax.co.uk';

// Avatar size - small for icon use
const AVATAR_SIZE = 128;

export const POST: APIRoute = async ({ request }) => {
  try {
    const formData = await request.formData();
    const file = formData.get('avatar') as File;
    const userId = formData.get('userId') as string;
    
    if (!file || !userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing file or user ID'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Validate file type
    const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!validTypes.includes(file.type)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid file type. Use JPG, PNG, WebP or GIF.'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Validate file size (2MB max for upload, will be compressed)
    const maxSize = 2 * 1024 * 1024;
    if (file.size > maxSize) {
      return new Response(JSON.stringify({
        success: false,
        error: 'File too large. Max 2MB.'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Convert file to buffer
    const arrayBuffer = await file.arrayBuffer();
    const inputBuffer = Buffer.from(arrayBuffer);
    
    // Compress and convert to WebP using sharp
    // Resize to 128x128, crop to square, convert to WebP with high compression
    const compressedBuffer = await sharp(inputBuffer)
      .resize(AVATAR_SIZE, AVATAR_SIZE, {
        fit: 'cover',
        position: 'center'
      })
      .webp({
        quality: 60,  // Lower quality for smaller size
        effort: 6     // Higher effort = better compression
      })
      .toBuffer();
    
    const originalSize = file.size;
    const compressedSize = compressedBuffer.length;
    console.log(`[upload-avatar] Compressed ${originalSize} -> ${compressedSize} bytes (${Math.round(compressedSize/originalSize*100)}%)`);
    
    // Always save as WebP now
    const filename = `avatars/${userId}.webp`;
    
    // Delete any old avatar files with different extensions
    const oldExtensions = ['jpg', 'png', 'gif'];
    for (const ext of oldExtensions) {
      try {
        await r2.send(new DeleteObjectCommand({
          Bucket: R2_BUCKET,
          Key: `avatars/${userId}.${ext}`,
        }));
      } catch (e) {
        // Ignore - file may not exist
      }
    }
    
    // Upload compressed WebP to R2
    await r2.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: filename,
      Body: compressedBuffer,
      ContentType: 'image/webp',
      CacheControl: 'public, max-age=86400', // 1 day cache
    }));
    
    const avatarUrl = `${R2_PUBLIC_URL}/${filename}?t=${Date.now()}`;
    
    // Update customer document
    await db.collection('customers').doc(userId).set({
      avatarUrl,
      avatarUpdatedAt: new Date().toISOString()
    }, { merge: true });
    
    console.log(`[upload-avatar] Avatar uploaded for user ${userId}: ${avatarUrl}`);
    
    return new Response(JSON.stringify({
      success: true,
      avatarUrl,
      originalSize,
      compressedSize
    }), { 
      status: 200, 
      headers: { 'Content-Type': 'application/json' } 
    });
    
  } catch (error) {
    console.error('[upload-avatar] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to upload avatar'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// DELETE: Remove avatar
export const DELETE: APIRoute = async ({ request }) => {
  try {
    const data = await request.json();
    const { userId } = data;
    
    if (!userId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing user ID'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    // Delete WebP avatar (and any old formats)
    const extensions = ['webp', 'jpg', 'png', 'gif'];
    for (const ext of extensions) {
      try {
        await r2.send(new DeleteObjectCommand({
          Bucket: R2_BUCKET,
          Key: `avatars/${userId}.${ext}`,
        }));
      } catch (e) {
        // Ignore errors for non-existent files
      }
    }
    
    // Remove avatar URL from customer document
    await db.collection('customers').doc(userId).set({
      avatarUrl: null,
      avatarUpdatedAt: new Date().toISOString()
    }, { merge: true });
    
    console.log(`[upload-avatar] Avatar removed for user ${userId}`);
    
    return new Response(JSON.stringify({
      success: true
    }), { 
      status: 200, 
      headers: { 'Content-Type': 'application/json' } 
    });
    
  } catch (error) {
    console.error('[upload-avatar] DELETE Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to remove avatar'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
