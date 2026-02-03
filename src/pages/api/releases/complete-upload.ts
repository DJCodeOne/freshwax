// src/pages/api/releases/complete-upload.ts
// Called after files are uploaded to R2 - creates Firebase document with status: 'pending'
// Uses Firebase Admin SDK to bypass security rules

import type { APIRoute } from 'astro';
import { getAdminDb } from '../../../lib/firebase-admin';
import { setDocument, getDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { d1UpsertRelease } from '../../../lib/d1-catalog';

export const prerender = false;

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log('[complete-upload]', ...args),
  error: (...args: any[]) => console.error('[complete-upload]', ...args),
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = (locals as any).runtime?.env;

    // Initialize Firebase REST API as fallback
    initFirebaseEnv({
      FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
      FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
    });

    const body = await request.json();
    const {
      releaseId,
      baseFolder,       // The folder where files were uploaded in R2
      artistName,
      releaseName,
      tracks,           // Array of { title, trackNumber, url, format, fileSize, duration? }
      coverArtUrl,
      uploadedBy,       // User ID who uploaded
      metadata = {},    // Additional metadata (genre, bpm, key, etc.)
    } = body;

    if (!releaseId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'releaseId is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (!artistName || !releaseName) {
      return new Response(JSON.stringify({
        success: false,
        error: 'artistName and releaseName are required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (!tracks || !Array.isArray(tracks) || tracks.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'At least one track is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Check if release already exists (for updates)
    const existingRelease = await getDocument('releases', releaseId);

    // Build track documents with consistent structure
    const processedTracks = tracks.map((track: any, index: number) => ({
      id: `${releaseId}_track_${track.trackNumber || index + 1}`,
      trackNumber: track.trackNumber || index + 1,
      title: track.title || `Track ${index + 1}`,
      artist: artistName,
      artistName: artistName,
      duration: track.duration || 0,
      url: track.url,
      mp3Url: track.format?.toLowerCase() === 'mp3' ? track.url : (track.mp3Url || null),
      wavUrl: track.format?.toLowerCase() === 'wav' ? track.url : (track.wavUrl || null),
      preview_url: track.previewUrl || track.url,
      format: track.format || 'MP3',
      fileSize: track.fileSize || 0,
      bpm: track.bpm || metadata.bpm || null,
      key: track.key || metadata.key || null,
      genre: track.genre || metadata.genre || null,
    }));

    // Determine release type
    const trackCount = processedTracks.length;
    const releaseType = trackCount === 1 ? 'single' : trackCount <= 4 ? 'ep' : 'album';

    // Build release document
    const releaseDoc = {
      id: releaseId,
      artistName,
      releaseName,
      artist: artistName,
      title: releaseName,
      coverArtUrl: coverArtUrl || '',
      coverArt: coverArtUrl || '',
      tracks: processedTracks,
      trackCount,
      status: existingRelease?.status || 'pending',
      approved: existingRelease?.approved || false,
      published: existingRelease?.published || false,
      type: releaseType,
      releaseType,
      uploadedAt: existingRelease?.uploadedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdAt: existingRelease?.createdAt || new Date().toISOString(),
      processedAt: new Date().toISOString(),
      uploadedBy: uploadedBy || existingRelease?.uploadedBy || null,
      submitterId: uploadedBy || existingRelease?.submitterId || existingRelease?.uploadedBy || null,
      // Metadata fields
      catalogNumber: metadata.catalogNumber || existingRelease?.catalogNumber || '',
      genre: metadata.genre || existingRelease?.genre || '',
      bpm: metadata.bpm || existingRelease?.bpm || null,
      key: metadata.key || existingRelease?.key || null,
      releaseDate: metadata.releaseDate || existingRelease?.releaseDate || null,
      description: metadata.description || existingRelease?.description || '',
      // Upload source info
      metadata: {
        ...existingRelease?.metadata,
        ...metadata,
        uploadSource: 'direct-r2-upload',
        lastUploadAt: new Date().toISOString(),
      },
    };

    try {
      // Try Firebase Admin SDK first (bypasses security rules)
      const adminDb = await getAdminDb();

      if (adminDb) {
        log.info('Using Firebase Admin SDK for write...');
        await adminDb.collection('releases').doc(releaseId).set(releaseDoc, { merge: true });
        log.info(`Release document created/updated via Admin SDK: ${releaseId}`);
      } else {
        // Fallback to REST API
        log.info('Admin SDK not available, using REST API...');
        await setDocument('releases', releaseId, releaseDoc);
        log.info(`Release document created/updated via REST API: ${releaseId}`);
      }

      // Dual-write to D1 (secondary, non-blocking)
      const db = env?.DB;
      if (db) {
        try {
          await d1UpsertRelease(db, releaseId, releaseDoc);
          log.info(`Release also written to D1: ${releaseId}`);
        } catch (d1Error) {
          // Log D1 error but don't fail the request
          log.error('D1 dual-write failed (non-critical):', d1Error);
        }
      }
    } catch (setError: any) {
      log.error('Firebase write failed:', setError);
      // Return more detailed error
      return new Response(JSON.stringify({
        success: false,
        error: `Firebase write failed: ${setError.message}`,
        details: {
          releaseId,
          collection: 'releases',
          apiKeyPresent: !!(env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY),
          projectId: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store'
        }
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({
      success: true,
      releaseId,
      release: releaseDoc,
      message: existingRelease ? 'Release updated successfully' : 'Release created successfully',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    log.error('Failed to complete upload:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to complete upload'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
