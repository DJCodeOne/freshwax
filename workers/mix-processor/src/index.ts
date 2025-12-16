// index.ts - Main entry point for DJ mix processor Worker
// Processes DJ mix uploads: artwork + audio file

import type { Env, MixSubmissionMetadata, ProcessedMix } from './types';
import { processArtwork } from './image-processor';
import { createMixInFirebase } from './firebase';
import { sendProcessingCompleteEmail, sendProcessingFailedEmail } from './email';

/**
 * Generate a unique mix ID from DJ name and timestamp
 */
function generateMixId(djName: string, title: string): string {
  const sanitizedDj = djName
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 20);
  const sanitizedTitle = title
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 30);
  const timestamp = Date.now();
  return `${sanitizedDj}_${sanitizedTitle}_${timestamp}`;
}

/**
 * Parse submission from R2 bucket (mix-submissions/ folder)
 */
async function parseSubmission(
  submissionId: string,
  env: Env
): Promise<{ metadata: MixSubmissionMetadata; artworkKey: string | null; audioKey: string | null }> {
  console.log(`[Parser] Parsing submission: ${submissionId}`);

  // Get metadata.json from mix-submissions/ folder
  const metadataKey = `mix-submissions/${submissionId}/metadata.json`;
  const metadataObj = await env.MIXES_BUCKET.get(metadataKey);

  if (!metadataObj) {
    throw new Error(`Metadata not found: ${metadataKey}`);
  }

  const metadata: MixSubmissionMetadata = await metadataObj.json();
  console.log(`[Parser] Metadata loaded: ${metadata.djName} - ${metadata.title}`);

  // List all files in submission folder
  const list = await env.MIXES_BUCKET.list({ prefix: `mix-submissions/${submissionId}/` });

  let artworkKey: string | null = null;
  let audioKey: string | null = null;

  for (const object of list.objects) {
    const key = object.key;
    const lowerKey = key.toLowerCase();

    // Skip metadata.json
    if (lowerKey.endsWith('metadata.json')) continue;

    // Detect artwork
    if (lowerKey.endsWith('.jpg') || lowerKey.endsWith('.jpeg') ||
        lowerKey.endsWith('.png') || lowerKey.endsWith('.webp')) {
      artworkKey = key;
      console.log(`[Parser] Found artwork: ${key}`);
    }
    // Detect audio
    else if (lowerKey.endsWith('.mp3') || lowerKey.endsWith('.wav') ||
             lowerKey.endsWith('.flac') || lowerKey.endsWith('.aiff') || lowerKey.endsWith('.aif')) {
      audioKey = key;
      console.log(`[Parser] Found audio: ${key}`);
    }
  }

  console.log(`[Parser] Artwork: ${artworkKey ? 'yes' : 'no'}, Audio: ${audioKey ? 'yes' : 'no'}`);

  return { metadata, artworkKey, audioKey };
}

/**
 * Copy audio file to final destination (DJ mixes don't need re-encoding)
 */
async function copyAudioFile(
  audioKey: string,
  mixId: string,
  env: Env
): Promise<{ audioUrl: string }> {
  console.log(`[Audio] Copying audio file: ${audioKey}`);

  // Get the audio file
  const audioObj = await env.MIXES_BUCKET.get(audioKey);
  if (!audioObj) {
    throw new Error(`Audio not found: ${audioKey}`);
  }

  // Determine content type
  const lowerKey = audioKey.toLowerCase();
  let contentType = 'audio/mpeg';
  if (lowerKey.endsWith('.wav')) contentType = 'audio/wav';
  else if (lowerKey.endsWith('.flac')) contentType = 'audio/flac';
  else if (lowerKey.endsWith('.aiff') || lowerKey.endsWith('.aif')) contentType = 'audio/aiff';

  // Determine file extension
  const ext = audioKey.split('.').pop()?.toLowerCase() || 'mp3';
  const outputKey = `dj-mixes/${mixId}/audio.${ext}`;

  // Copy to final destination
  const audioBuffer = await audioObj.arrayBuffer();
  await env.MIXES_BUCKET.put(outputKey, audioBuffer, {
    httpMetadata: {
      contentType,
      cacheControl: 'public, max-age=31536000'
    }
  });

  const audioUrl = `${env.R2_PUBLIC_DOMAIN}/${outputKey}`;
  console.log(`[Audio] Uploaded audio: ${audioUrl} (${audioBuffer.byteLength} bytes)`);

  return { audioUrl };
}

/**
 * Process a mix submission
 */
async function processSubmission(
  submissionId: string,
  env: Env
): Promise<ProcessedMix> {
  const { metadata, artworkKey, audioKey } = await parseSubmission(submissionId, env);
  const mixId = generateMixId(metadata.djName, metadata.title);

  console.log(`[Processor] Starting: ${mixId}`);
  console.log(`[Processor] DJ: ${metadata.djName}`);
  console.log(`[Processor] Title: ${metadata.title}`);

  // Process artwork
  let artworkUrl = '';
  if (artworkKey) {
    const artworkResult = await processArtwork(submissionId, artworkKey, mixId, env);
    artworkUrl = artworkResult.artworkUrl;
  } else {
    console.log('[Processor] No artwork, using placeholder');
    artworkUrl = `${env.R2_PUBLIC_DOMAIN}/place-holder.webp`;
  }

  // Copy audio file
  let audioUrl = '';
  if (audioKey) {
    const audioResult = await copyAudioFile(audioKey, mixId, env);
    audioUrl = audioResult.audioUrl;
  } else {
    throw new Error('No audio file found in submission');
  }

  const now = new Date().toISOString();
  const folderPath = `dj-mixes/${mixId}`;

  // Parse tracklist into array
  const tracklistArray = metadata.tracklist
    ? metadata.tracklist.split('\n').map(t => t.trim()).filter(t => t.length > 0)
    : [];

  // Format duration
  const durationSeconds = metadata.durationSeconds || 0;
  const hrs = Math.floor(durationSeconds / 3600);
  const mins = Math.floor((durationSeconds % 3600) / 60);
  const secs = Math.floor(durationSeconds % 60);
  const durationFormatted = hrs > 0
    ? `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    : `${mins}:${secs.toString().padStart(2, '0')}`;

  return {
    id: mixId,
    title: metadata.title,
    name: metadata.title,
    mixTitle: metadata.mixTitle || metadata.title,
    djName: metadata.djName,
    dj_name: metadata.djName,
    displayName: metadata.displayName || metadata.djName,
    userId: metadata.userId,
    email: metadata.email,

    // URLs
    audioUrl,
    audio_url: audioUrl,
    mp3Url: audioUrl,
    artworkUrl,
    artwork_url: artworkUrl,
    imageUrl: artworkUrl,

    // Details
    genre: metadata.genre || 'Drum and Bass',
    description: metadata.description || metadata.shoutOuts || '',
    shoutOuts: metadata.shoutOuts || metadata.description || '',
    tracklist: metadata.tracklist || '',
    tracklistArray,
    trackCount: tracklistArray.length,

    // Duration
    duration: metadata.duration || durationFormatted,
    durationSeconds,
    durationFormatted,
    durationMs: durationSeconds * 1000,

    // Stats (initialized to 0)
    plays: 0,
    playCount: 0,
    likes: 0,
    likeCount: 0,
    downloads: 0,
    downloadCount: 0,
    commentCount: 0,

    // Ratings
    ratings: {
      count: 0,
      total: 0,
      average: 0
    },

    // Settings
    allowDownload: metadata.allowDownload !== false,
    published: metadata.published !== false,
    featured: false,
    approved: true,

    // Status
    status: 'live',
    storage: 'r2',

    // Timestamps
    createdAt: now,
    uploadedAt: now,
    updatedAt: now,
    upload_date: now,

    // R2 metadata
    folder_path: folderPath,
    r2FolderName: mixId
  };
}

/**
 * Delete submission files from bucket
 */
async function deleteSubmission(submissionId: string, env: Env): Promise<void> {
  console.log(`[Cleanup] Deleting: ${submissionId}`);

  const list = await env.MIXES_BUCKET.list({ prefix: `mix-submissions/${submissionId}/` });

  for (const object of list.objects) {
    await env.MIXES_BUCKET.delete(object.key);
  }

  console.log(`[Cleanup] Deleted ${list.objects.length} files`);
}

/**
 * List all pending submissions
 */
async function listSubmissions(env: Env): Promise<string[]> {
  const list = await env.MIXES_BUCKET.list({ prefix: 'mix-submissions/' });
  const submissions = new Set<string>();

  for (const object of list.objects) {
    const parts = object.key.split('/');
    if (parts.length >= 3 && parts[0] === 'mix-submissions') {
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
        service: 'mix-processor',
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

        console.log(`[API] Processing mix submission: ${submissionId}`);

        // Process the submission
        const mix = await processSubmission(submissionId, env);

        // Save to Firebase
        await createMixInFirebase(mix, env);

        // Send success email
        await sendProcessingCompleteEmail(mix, env);

        // Delete original files
        await deleteSubmission(submissionId, env);

        console.log(`[API] Complete: ${mix.id}`);

        return new Response(JSON.stringify({
          success: true,
          mixId: mix.id,
          dj: mix.djName,
          title: mix.title,
          audioUrl: mix.audioUrl,
          artworkUrl: mix.artworkUrl
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });

      } catch (error) {
        console.error('[API] Processing failed:', error);

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
      service: 'Fresh Wax Mix Processor',
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
