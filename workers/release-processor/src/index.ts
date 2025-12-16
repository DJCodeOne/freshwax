// index.ts - Main entry point for release processor Worker
// Processes releases directly without queues (simpler, works on free plan)

import type { Env, SubmissionMetadata, ProcessedRelease } from './types';
import { processArtwork } from './image-processor';
import { processAudioTrack, terminateFFmpeg } from './audio-processor';
import { createReleaseInFirebase } from './firebase';
import { sendProcessingCompleteEmail, sendProcessingFailedEmail } from './email';

/**
 * Generate a unique release ID from artist name and timestamp
 */
function generateReleaseId(artistName: string): string {
  const sanitized = artistName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 30);
  const timestamp = Date.now();
  return `${sanitized}_FW-${timestamp}`;
}

/**
 * Parse submission from R2 bucket (submissions/ folder in releases bucket)
 */
async function parseSubmission(
  submissionId: string,
  env: Env
): Promise<{ metadata: SubmissionMetadata; artworkKey: string | null; trackKeys: string[] }> {
  console.log(`[Parser] Parsing submission: ${submissionId}`);

  // Get metadata.json from submissions/ folder
  const metadataKey = `submissions/${submissionId}/metadata.json`;
  const metadataObj = await env.RELEASES_BUCKET.get(metadataKey);

  if (!metadataObj) {
    throw new Error(`Metadata not found: ${metadataKey}`);
  }

  const metadata: SubmissionMetadata = await metadataObj.json();
  console.log(`[Parser] Metadata loaded: ${metadata.artistName} - ${metadata.releaseName}`);

  // List all files in submission folder
  const list = await env.RELEASES_BUCKET.list({ prefix: `submissions/${submissionId}/` });

  let artworkKey: string | null = null;
  const trackKeys: string[] = [];

  for (const object of list.objects) {
    const key = object.key;
    const lowerKey = key.toLowerCase();

    // Skip metadata.json
    if (lowerKey.endsWith('metadata.json')) continue;

    // Detect artwork
    if (lowerKey.includes('artwork') || lowerKey.includes('cover')) {
      if (lowerKey.endsWith('.jpg') || lowerKey.endsWith('.jpeg') ||
          lowerKey.endsWith('.png') || lowerKey.endsWith('.webp')) {
        artworkKey = key;
        console.log(`[Parser] Found artwork: ${key}`);
      }
    }
    // Detect audio tracks
    else if (lowerKey.includes('/tracks/') || lowerKey.includes('track')) {
      if (lowerKey.endsWith('.mp3') || lowerKey.endsWith('.wav') ||
          lowerKey.endsWith('.flac') || lowerKey.endsWith('.aiff') || lowerKey.endsWith('.aif')) {
        trackKeys.push(key);
        console.log(`[Parser] Found track: ${key}`);
      }
    }
    // Root level audio files
    else if (lowerKey.endsWith('.mp3') || lowerKey.endsWith('.wav') ||
             lowerKey.endsWith('.flac') || lowerKey.endsWith('.aiff') || lowerKey.endsWith('.aif')) {
      trackKeys.push(key);
      console.log(`[Parser] Found track (root): ${key}`);
    }
    // Root level images could be artwork
    else if (!artworkKey && (lowerKey.endsWith('.jpg') || lowerKey.endsWith('.jpeg') ||
             lowerKey.endsWith('.png') || lowerKey.endsWith('.webp'))) {
      artworkKey = key;
      console.log(`[Parser] Found artwork (root): ${key}`);
    }
  }

  // Sort tracks by filename
  trackKeys.sort();

  console.log(`[Parser] Found ${trackKeys.length} tracks, artwork: ${artworkKey ? 'yes' : 'no'}`);

  return { metadata, artworkKey, trackKeys };
}

/**
 * Process a release submission
 */
async function processSubmission(
  submissionId: string,
  env: Env
): Promise<ProcessedRelease> {
  const { metadata, artworkKey, trackKeys } = await parseSubmission(submissionId, env);
  const releaseId = generateReleaseId(metadata.artistName);

  console.log(`[Processor] Starting: ${releaseId}`);
  console.log(`[Processor] Artist: ${metadata.artistName}`);
  console.log(`[Processor] Release: ${metadata.releaseName}`);
  console.log(`[Processor] Tracks: ${trackKeys.length}`);

  // Process artwork
  let coverUrl = '';
  let thumbUrl = '';

  if (artworkKey) {
    const artworkResult = await processArtwork(submissionId, artworkKey, releaseId, env);
    coverUrl = artworkResult.coverUrl;
    thumbUrl = artworkResult.thumbUrl;
  } else {
    console.log('[Processor] No artwork, using placeholder');
    coverUrl = `${env.R2_PUBLIC_DOMAIN}/place-holder.webp`;
    thumbUrl = coverUrl;
  }

  // Process each track
  const processedTracks = [];

  for (let i = 0; i < trackKeys.length; i++) {
    const trackKey = trackKeys[i];
    const trackMetadata = metadata.tracks[i] || {
      trackNumber: i + 1,
      title: `Track ${i + 1}`
    };

    console.log(`[Processor] Track ${i + 1}/${trackKeys.length}: ${trackMetadata.title}`);

    try {
      const processedTrack = await processAudioTrack(
        trackKey,
        trackMetadata,
        releaseId,
        env
      );
      processedTracks.push(processedTrack);
    } catch (error) {
      console.error(`[Processor] Track ${i + 1} failed:`, error);
      // Continue with other tracks
      processedTracks.push({
        trackNumber: trackMetadata.trackNumber,
        title: trackMetadata.title,
        mp3Url: '',
        wavUrl: '',
        previewUrl: '',
        bpm: trackMetadata.bpm,
        key: trackMetadata.key
      });
    }
  }

  // Clean up FFmpeg
  terminateFFmpeg();

  const now = new Date().toISOString();

  // Map processed tracks with additional metadata from submission
  const enrichedTracks = processedTracks.map((track, index) => {
    const submissionTrack = metadata.tracks[index] || {};
    return {
      ...track,
      trackNumber: track.trackNumber,
      displayTrackNumber: submissionTrack.trackNumber || index + 1,
      title: track.title || submissionTrack.title || submissionTrack.trackName || `Track ${index + 1}`,
      trackName: submissionTrack.trackName || track.title,
      trackISRC: submissionTrack.trackISRC || '',
      featured: submissionTrack.featured || '',
      remixer: submissionTrack.remixer || '',
      explicit: submissionTrack.explicit || false
    };
  });

  // Build social links object
  const socialLinks = metadata.socialLinks || {
    instagram: metadata.instagramLink || '',
    soundcloud: metadata.soundcloudLink || '',
    spotify: metadata.spotifyLink || '',
    bandcamp: metadata.bandcampLink || '',
    youtube: metadata.youtubeLink || '',
    other: metadata.otherLinks || ''
  };

  return {
    id: releaseId,
    artistName: metadata.artistName,
    releaseName: metadata.releaseName,
    title: metadata.releaseName,
    artist: metadata.artistName,
    coverUrl,
    thumbUrl,
    tracks: enrichedTracks,

    // Release Details
    releaseType: metadata.releaseType || 'EP',
    labelCode: metadata.labelCode || metadata.catalogNumber || '',
    masteredBy: metadata.masteredBy || '',
    genre: metadata.genre || 'Drum and Bass',
    catalogNumber: metadata.catalogNumber || metadata.labelCode || '',
    releaseDate: metadata.releaseDate,
    description: metadata.description || metadata.releaseDescription || '',
    releaseDescription: metadata.releaseDescription || metadata.description || '',

    // Pre-order
    hasPreOrder: metadata.hasPreOrder || false,
    preOrderDate: metadata.preOrderDate || null,

    // Content flags
    hasExplicitContent: metadata.hasExplicitContent || false,

    // Previous release info
    isPreviouslyReleased: metadata.isPreviouslyReleased || false,
    originalReleaseDate: metadata.originalReleaseDate || null,
    recordingLocation: metadata.recordingLocation || '',
    recordingYear: metadata.recordingYear || '',

    // Copyright & Publishing
    copyrightYear: metadata.copyrightYear || new Date().getFullYear().toString(),
    copyrightHolder: metadata.copyrightHolder || metadata.artistName,
    publishingRights: metadata.publishingRights || '',
    publishingCompany: metadata.publishingCompany || '',
    primaryLanguage: metadata.primaryLanguage || 'English',

    // Pricing
    pricePerSale: metadata.pricePerSale || 5.00,
    trackPrice: metadata.trackPrice || 1.00,

    // Vinyl
    vinylRelease: metadata.vinylRelease || false,
    vinylPrice: metadata.vinylPrice || null,
    vinylRecordCount: metadata.vinylRecordCount || metadata.vinyl?.recordCount || '',
    vinylRPM: metadata.vinylRPM || metadata.vinyl?.rpm || '33',
    vinylSize: metadata.vinylSize || metadata.vinyl?.size || '12"',
    vinylWeight: metadata.vinylWeight || metadata.vinyl?.weight || '140g',
    pressingPlant: metadata.pressingPlant || metadata.vinyl?.pressingPlant || '',
    expectedShippingDate: metadata.expectedShippingDate || metadata.vinyl?.expectedShippingDate || null,

    // Limited Edition
    hasLimitedEdition: metadata.hasLimitedEdition || metadata.limitedEdition?.enabled || false,
    limitedEditionType: metadata.limitedEditionType || metadata.limitedEdition?.type || '',
    limitedEditionDetails: metadata.limitedEditionDetails || metadata.limitedEdition?.details || '',

    // Social Links
    socialLinks,

    // Barcode
    upcEanCode: metadata.upcEanCode || '',

    // Notes
    notes: metadata.notes || '',

    // Status
    status: 'pending',
    published: false,
    approved: false,
    storage: 'r2',
    createdAt: now,
    updatedAt: now,
    processedAt: now,

    // Email for notifications
    email: metadata.email,
    userId: metadata.userId
  };
}

/**
 * Delete submission files from releases bucket (submissions/ folder)
 */
async function deleteSubmission(submissionId: string, env: Env): Promise<void> {
  console.log(`[Cleanup] Deleting: ${submissionId}`);

  const list = await env.RELEASES_BUCKET.list({ prefix: `submissions/${submissionId}/` });

  for (const object of list.objects) {
    await env.RELEASES_BUCKET.delete(object.key);
  }

  console.log(`[Cleanup] Deleted ${list.objects.length} files`);
}

/**
 * List all pending submissions (from submissions/ folder in releases bucket)
 */
async function listSubmissions(env: Env): Promise<string[]> {
  const list = await env.RELEASES_BUCKET.list({ prefix: 'submissions/' });
  const submissions = new Set<string>();

  for (const object of list.objects) {
    // Extract submission folder from path like "submissions/{submissionId}/..."
    const parts = object.key.split('/');
    if (parts.length >= 3 && parts[0] === 'submissions') {
      submissions.add(parts[1]);
    }
  }

  return Array.from(submissions);
}

// =============================================================================
// WORKER EXPORT
// =============================================================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'release-processor',
        version: '1.0.0'
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // List pending submissions
    if (url.pathname === '/submissions' && request.method === 'GET') {
      try {
        const submissions = await listSubmissions(env);
        return new Response(JSON.stringify({ submissions }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          error: error instanceof Error ? error.message : 'Unknown error'
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // Process a submission
    if (url.pathname === '/process' && request.method === 'POST') {
      let submissionId = '';

      try {
        const body = await request.json() as { submissionId: string };
        submissionId = body.submissionId;

        if (!submissionId) {
          return new Response(JSON.stringify({ error: 'submissionId required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        console.log(`[API] Processing submission: ${submissionId}`);

        // Process the submission
        const release = await processSubmission(submissionId, env);

        // Save to Firebase
        await createReleaseInFirebase(release, env);

        // Send success email
        await sendProcessingCompleteEmail(release, env);

        // Delete original files
        await deleteSubmission(submissionId, env);

        console.log(`[API] Complete: ${release.id}`);

        return new Response(JSON.stringify({
          success: true,
          releaseId: release.id,
          artist: release.artistName,
          title: release.releaseName,
          tracks: release.tracks.length,
          coverUrl: release.coverUrl
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });

      } catch (error) {
        console.error('[API] Processing failed:', error);

        // Clean up FFmpeg on error
        terminateFFmpeg();

        // Send failure email
        if (submissionId) {
          await sendProcessingFailedEmail(
            submissionId,
            error instanceof Error ? error.message : 'Unknown error',
            env
          ).catch(e => console.error('Failed to send error email:', e));
        }

        return new Response(JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // Default response
    return new Response(JSON.stringify({
      service: 'Fresh Wax Release Processor',
      endpoints: {
        'GET /health': 'Health check',
        'GET /submissions': 'List pending submissions',
        'POST /process': 'Process a submission { submissionId: string }'
      }
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
};
