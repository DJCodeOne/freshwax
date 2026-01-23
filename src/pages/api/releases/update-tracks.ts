// src/pages/api/releases/update-tracks.ts
// Updates release tracks with processed audio URLs (MP3, WAV, preview)

import type { APIRoute } from 'astro';
import { getDocument, setDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { getAdminKey } from '../../../lib/api-utils';

export const prerender = false;

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log('[update-tracks]', ...args),
  error: (...args: any[]) => console.error('[update-tracks]', ...args),
};

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any).runtime?.env;

  // Admin key required
  const adminKey = getAdminKey(request);
  const expectedAdminKey = env?.ADMIN_KEY || import.meta.env.ADMIN_KEY;

  if (!adminKey || adminKey !== expectedAdminKey) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Admin authentication required'
    }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    // Initialize Firebase
    initFirebaseEnv({
      FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
      FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
    });

    const body = await request.json();
    const { releaseId, tracks } = body;

    if (!releaseId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'releaseId is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (!tracks || !Array.isArray(tracks)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'tracks array is required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Get existing release
    const existingRelease = await getDocument('releases', releaseId);
    if (!existingRelease) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Release not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    log.info(`Updating tracks for release: ${releaseId}`);
    log.info(`Tracks to update: ${tracks.length}`);

    // Update existing tracks with processed URLs
    const updatedTracks = (existingRelease.tracks || []).map((existingTrack: any) => {
      const processedTrack = tracks.find((t: any) => t.trackNumber === existingTrack.trackNumber);

      if (processedTrack) {
        return {
          ...existingTrack,
          mp3Url: processedTrack.mp3Url || existingTrack.mp3Url,
          wavUrl: processedTrack.wavUrl || existingTrack.wavUrl,
          previewUrl: processedTrack.previewUrl || existingTrack.previewUrl || existingTrack.preview_url,
          preview_url: processedTrack.previewUrl || existingTrack.preview_url || existingTrack.previewUrl,
          // Update main URL to MP3 for streaming
          url: processedTrack.mp3Url || existingTrack.url,
          // Add file sizes if provided
          mp3Size: processedTrack.mp3Size || existingTrack.mp3Size,
          wavSize: processedTrack.wavSize || existingTrack.wavSize,
          audioProcessed: true,
          processedAt: new Date().toISOString(),
        };
      }

      return existingTrack;
    });

    // Update release document
    const updatedRelease = {
      ...existingRelease,
      tracks: updatedTracks,
      audioProcessed: true,
      audioProcessedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await setDocument('releases', releaseId, updatedRelease);
    log.info(`Release updated: ${releaseId}`);

    return new Response(JSON.stringify({
      success: true,
      releaseId,
      tracksUpdated: tracks.length,
      message: 'Tracks updated with processed audio URLs'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    log.error('Failed to update tracks:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update tracks'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
