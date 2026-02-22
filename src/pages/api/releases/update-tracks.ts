// src/pages/api/releases/update-tracks.ts
// Updates release tracks with processed audio URLs (MP3, WAV, preview)

import type { APIRoute } from 'astro';
import { getDocument } from '../../../lib/firebase-rest';
import { saSetDocument, getServiceAccountKey } from '../../../lib/firebase-service-account';
import { getAdminKey, ApiErrors, createLogger } from '../../../lib/api-utils';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';

export const prerender = false;

const logger = createLogger('update-tracks');

export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateLimit = checkRateLimit(`update-tracks:${clientId}`, RateLimiters.standard);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfter!);
  }

  const env = locals.runtime.env;

  // Admin key required
  const adminKey = getAdminKey(request);
  const expectedAdminKey = env?.ADMIN_KEY || import.meta.env.ADMIN_KEY;

  if (!adminKey || adminKey !== expectedAdminKey) {
    return ApiErrors.unauthorized('Admin authentication required');
  }

  try {

    const body = await request.json();
    const { releaseId, tracks } = body;

    if (!releaseId) {
      return ApiErrors.badRequest('releaseId is required');
    }

    if (!tracks || !Array.isArray(tracks)) {
      return ApiErrors.badRequest('tracks array is required');
    }

    // Get existing release
    const existingRelease = await getDocument('releases', releaseId);
    if (!existingRelease) {
      return ApiErrors.notFound('Release not found');
    }

    logger.info(`Updating tracks for release: ${releaseId}`);
    logger.info(`Tracks to update: ${tracks.length}`);

    // Update existing tracks with processed URLs
    // Match by canonical trackNumber (displayTrackNumber - 1) since trackNumber field can be inconsistent
    const updatedTracks = (existingRelease.tracks || []).map((existingTrack: Record<string, unknown>, index: number) => {
      // Use displayTrackNumber - 1 as canonical index, fallback to array index
      const canonicalIndex = existingTrack.displayTrackNumber ? existingTrack.displayTrackNumber - 1 : index;
      const processedTrack = tracks.find((t: Record<string, unknown>) => t.trackNumber === canonicalIndex);

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

    // Use service account for authenticated write
    const serviceAccountKey = getServiceAccountKey(env);
    const projectId = env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

    if (!serviceAccountKey) {
      throw new Error('Firebase service account not configured - missing FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY');
    }

    await saSetDocument(serviceAccountKey, projectId, 'releases', releaseId, updatedRelease);
    logger.info(`Release updated: ${releaseId}`);

    return new Response(JSON.stringify({
      success: true,
      releaseId,
      tracksUpdated: tracks.length,
      message: 'Tracks updated with processed audio URLs'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    logger.error('Failed to update tracks:', error);
    return ApiErrors.serverError('Failed to update tracks');
  }
};
