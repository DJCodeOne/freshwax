// src/pages/api/fix-artwork-url.ts
// Checks R2 for actual artwork filename and updates Firestore

import '../../lib/dom-polyfill'; // DOM polyfill for AWS SDK on Cloudflare Workers
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { updateDocument, initFirebaseEnv } from '../../lib/firebase-rest';

export const POST = async ({ request, locals }: any) => {
  try {
    const { releaseId } = await request.json();

    if (!releaseId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing releaseId'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const env = locals?.runtime?.env || {};

    // R2 config
    const accountId = env.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID;
    const accessKeyId = env.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = env.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY;
    const bucketName = env.R2_RELEASES_BUCKET || import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases';
    const publicDomain = env.R2_PUBLIC_DOMAIN || import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk';

    if (!accountId || !accessKeyId || !secretAccessKey) {
      return new Response(JSON.stringify({
        success: false,
        error: 'R2 credentials not configured'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Initialize Firebase environment
    initFirebaseEnv({
      FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
      FIREBASE_API_KEY: env.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
    });

    // List files in R2
    const r2Client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    const command = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: `releases/${releaseId}/artwork/`,
    });

    const response = await r2Client.send(command);
    const artworkFiles = response.Contents || [];

    if (artworkFiles.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'No artwork files found in R2 for this release'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Find the cover file (prefer file named 'cover' or first image file)
    let coverFile = artworkFiles[0];
    for (const file of artworkFiles) {
      const filename = file.Key?.split('/').pop()?.toLowerCase() || '';
      if (filename.startsWith('cover')) {
        coverFile = file;
        break;
      }
    }

    const coverFilename = coverFile.Key?.split('/').pop();
    const newCoverArtUrl = `${publicDomain}/releases/${releaseId}/artwork/${coverFilename}`;

    // Update Firestore
    await updateDocument('releases', releaseId, {
      coverArtUrl: newCoverArtUrl,
      updatedAt: new Date().toISOString()
    });

    return new Response(JSON.stringify({
      success: true,
      releaseId,
      artworkFilesFound: artworkFiles.map(f => f.Key?.split('/').pop()),
      selectedCover: coverFilename,
      newCoverArtUrl,
      message: `Updated coverArtUrl to ${newCoverArtUrl}`
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[fix-artwork-url] Error:', error);
    
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fix artwork URL'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
