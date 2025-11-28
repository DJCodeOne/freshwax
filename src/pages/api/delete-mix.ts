// src/pages/api/delete-mix.ts
// Deletes DJ mix from Firebase and R2 storage

import type { APIRoute } from 'astro';
import { S3Client, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// R2 Configuration
const R2_CONFIG = {
  accountId: import.meta.env.R2_ACCOUNT_ID,
  accessKeyId: import.meta.env.R2_ACCESS_KEY_ID,
  secretAccessKey: import.meta.env.R2_SECRET_ACCESS_KEY,
  bucketName: import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
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

export const POST: APIRoute = async ({ request }) => {
  try {
    const { mixId, folderPath } = await request.json();

    if (!mixId) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Mix ID is required' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log('=== Deleting DJ Mix ===');
    console.log('Mix ID:', mixId);
    console.log('Folder Path:', folderPath);

    // ============================================
    // 1. GET MIX DATA FROM FIREBASE
    // ============================================
    const mixDoc = await db.collection('dj-mixes').doc(mixId).get();
    
    if (!mixDoc.exists) {
      console.log('Mix not found in Firebase, may already be deleted');
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'Mix not found (may already be deleted)' 
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const mixData = mixDoc.data();
    const r2FolderPath = folderPath || mixData?.folder_path || `dj-mixes/${mixId}`;

    console.log('Mix data retrieved:', mixData?.title);
    console.log('R2 folder to delete:', r2FolderPath);

    // ============================================
    // 2. DELETE FILES FROM R2 STORAGE
    // ============================================
    try {
      // List all objects in the mix folder
      const listCommand = new ListObjectsV2Command({
        Bucket: R2_CONFIG.bucketName,
        Prefix: r2FolderPath,
      });

      const listedObjects = await s3Client.send(listCommand);

      if (listedObjects.Contents && listedObjects.Contents.length > 0) {
        console.log(`Found ${listedObjects.Contents.length} files to delete from R2`);

        // Delete each object
        for (const object of listedObjects.Contents) {
          if (object.Key) {
            console.log('Deleting R2 object:', object.Key);
            await s3Client.send(
              new DeleteObjectCommand({
                Bucket: R2_CONFIG.bucketName,
                Key: object.Key,
              })
            );
          }
        }

        console.log('✓ All R2 files deleted');
      } else {
        console.log('No R2 files found to delete (folder may be empty or already deleted)');
      }
    } catch (r2Error) {
      console.error('R2 deletion error (continuing anyway):', r2Error);
      // Continue with Firebase deletion even if R2 fails
    }

    // ============================================
    // 3. DELETE COMMENTS SUBCOLLECTION (if exists)
    // ============================================
    try {
      const commentsSnapshot = await db.collection('dj-mixes').doc(mixId).collection('comments').get();
      
      if (!commentsSnapshot.empty) {
        console.log(`Deleting ${commentsSnapshot.size} comments`);
        const batch = db.batch();
        commentsSnapshot.docs.forEach(doc => {
          batch.delete(doc.ref);
        });
        await batch.commit();
        console.log('✓ Comments deleted');
      }
    } catch (commentsError) {
      console.error('Error deleting comments (continuing):', commentsError);
    }

    // ============================================
    // 4. DELETE MIX DOCUMENT FROM FIREBASE
    // ============================================
    await db.collection('dj-mixes').doc(mixId).delete();
    console.log('✓ Mix document deleted from Firebase');

    console.log('=== Mix Deletion Complete ===');

    return new Response(JSON.stringify({ 
      success: true, 
      message: 'Mix deleted successfully',
      deletedId: mixId,
      deletedFolder: r2FolderPath
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('=== Delete Error ===');
    console.error(error);

    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Failed to delete mix',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};