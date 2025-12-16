// audio-processor.ts - Audio transcoding using ffmpeg-wasm
// Handles WAV<->MP3 conversion and 60-second preview clips

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import type { Env, ProcessedTrack, TrackMetadata } from './types';

let ffmpegInstance: FFmpeg | null = null;

/**
 * Get or create FFmpeg instance (singleton per request)
 */
async function getFFmpeg(): Promise<FFmpeg> {
  if (!ffmpegInstance) {
    ffmpegInstance = new FFmpeg();

    // Configure logging
    ffmpegInstance.on('log', ({ message }) => {
      console.log(`[FFmpeg] ${message}`);
    });

    ffmpegInstance.on('progress', ({ progress }) => {
      console.log(`[FFmpeg] Progress: ${Math.round(progress * 100)}%`);
    });

    console.log('[FFmpeg] Loading...');
    await ffmpegInstance.load();
    console.log('[FFmpeg] Loaded successfully');
  }
  return ffmpegInstance;
}

/**
 * Clean up FFmpeg instance
 */
export function terminateFFmpeg(): void {
  if (ffmpegInstance) {
    ffmpegInstance.terminate();
    ffmpegInstance = null;
    console.log('[FFmpeg] Terminated');
  }
}

/**
 * Get audio duration in seconds using FFmpeg
 */
async function getAudioDuration(ffmpeg: FFmpeg, inputFile: string): Promise<number> {
  // FFmpeg doesn't directly return duration, so we estimate based on file processing
  // For now, return 0 and let the client calculate from audio element
  return 0;
}

/**
 * Convert WAV to MP3 (320kbps)
 */
async function convertWavToMp3(ffmpeg: FFmpeg, inputData: Uint8Array): Promise<Uint8Array> {
  console.log('[Audio] Converting WAV to MP3...');

  await ffmpeg.writeFile('input.wav', inputData);

  await ffmpeg.exec([
    '-i', 'input.wav',
    '-codec:a', 'libmp3lame',
    '-b:a', '320k',
    '-ar', '44100',
    '-y',
    'output.mp3'
  ]);

  const output = await ffmpeg.readFile('output.mp3');

  // Cleanup
  await ffmpeg.deleteFile('input.wav');
  await ffmpeg.deleteFile('output.mp3');

  console.log(`[Audio] WAV to MP3 complete: ${output.length} bytes`);
  return output as Uint8Array;
}

/**
 * Convert MP3 to WAV (for HQ downloads)
 */
async function convertMp3ToWav(ffmpeg: FFmpeg, inputData: Uint8Array): Promise<Uint8Array> {
  console.log('[Audio] Converting MP3 to WAV...');

  await ffmpeg.writeFile('input.mp3', inputData);

  await ffmpeg.exec([
    '-i', 'input.mp3',
    '-codec:a', 'pcm_s16le',
    '-ar', '44100',
    '-y',
    'output.wav'
  ]);

  const output = await ffmpeg.readFile('output.wav');

  // Cleanup
  await ffmpeg.deleteFile('input.mp3');
  await ffmpeg.deleteFile('output.wav');

  console.log(`[Audio] MP3 to WAV complete: ${output.length} bytes`);
  return output as Uint8Array;
}

/**
 * Create 60-second preview clip with fade out
 * Starts at 30s mark if track is long enough, otherwise from start
 */
async function createPreviewClip(ffmpeg: FFmpeg, inputData: Uint8Array, inputFormat: 'mp3' | 'wav'): Promise<Uint8Array> {
  console.log('[Audio] Creating 60-second preview clip...');

  const inputFile = `input.${inputFormat}`;
  await ffmpeg.writeFile(inputFile, inputData);

  // Try to start at 30 seconds for variety, fall back to 0 if track is short
  // The -ss flag will be ignored if the track is shorter than 30s
  await ffmpeg.exec([
    '-i', inputFile,
    '-ss', '30',           // Start at 30 seconds (or 0 if shorter)
    '-t', '60',            // Duration 60 seconds
    '-codec:a', 'libmp3lame',
    '-b:a', '192k',        // Lower bitrate for previews
    '-ar', '44100',
    '-af', 'afade=t=out:st=55:d=5',  // Fade out last 5 seconds
    '-y',
    'preview.mp3'
  ]);

  const output = await ffmpeg.readFile('preview.mp3');

  // Cleanup
  await ffmpeg.deleteFile(inputFile);
  await ffmpeg.deleteFile('preview.mp3');

  console.log(`[Audio] Preview clip complete: ${output.length} bytes`);
  return output as Uint8Array;
}

/**
 * Detect audio format from file extension
 */
function getAudioFormat(filename: string): 'mp3' | 'wav' | 'flac' | 'aiff' | 'unknown' {
  const ext = filename.toLowerCase().split('.').pop();
  switch (ext) {
    case 'mp3': return 'mp3';
    case 'wav': return 'wav';
    case 'flac': return 'flac';
    case 'aiff':
    case 'aif': return 'aiff';
    default: return 'unknown';
  }
}

/**
 * Process a single audio track
 * - Ensures both MP3 and WAV versions exist
 * - Creates 60-second preview clip
 */
export async function processAudioTrack(
  trackKey: string,
  trackMetadata: TrackMetadata,
  releaseId: string,
  env: Env
): Promise<ProcessedTrack> {
  const trackNumber = trackMetadata.trackNumber;
  const trackTitle = trackMetadata.title;
  const paddedNum = trackNumber.toString().padStart(2, '0');

  console.log(`[Audio] Processing track ${trackNumber}: ${trackTitle}`);

  // Download track from releases bucket (submissions/ folder)
  const trackObj = await env.RELEASES_BUCKET.get(trackKey);
  if (!trackObj) {
    throw new Error(`Track not found: ${trackKey}`);
  }

  const trackBuffer = new Uint8Array(await trackObj.arrayBuffer());
  const sourceFormat = getAudioFormat(trackKey);
  console.log(`[Audio] Downloaded track: ${trackBuffer.byteLength} bytes, format: ${sourceFormat}`);

  const ffmpeg = await getFFmpeg();

  let mp3Data: Uint8Array;
  let wavData: Uint8Array;

  // Process based on source format
  if (sourceFormat === 'wav') {
    wavData = trackBuffer;
    mp3Data = await convertWavToMp3(ffmpeg, trackBuffer);
  } else if (sourceFormat === 'mp3') {
    mp3Data = trackBuffer;
    wavData = await convertMp3ToWav(ffmpeg, trackBuffer);
  } else if (sourceFormat === 'flac' || sourceFormat === 'aiff') {
    // Convert lossless formats to both MP3 and WAV
    console.log(`[Audio] Converting ${sourceFormat} to MP3 and WAV...`);

    const inputFile = `input.${sourceFormat}`;
    await ffmpeg.writeFile(inputFile, trackBuffer);

    // Convert to MP3
    await ffmpeg.exec([
      '-i', inputFile,
      '-codec:a', 'libmp3lame',
      '-b:a', '320k',
      '-ar', '44100',
      '-y',
      'output.mp3'
    ]);
    mp3Data = await ffmpeg.readFile('output.mp3') as Uint8Array;

    // Convert to WAV
    await ffmpeg.exec([
      '-i', inputFile,
      '-codec:a', 'pcm_s16le',
      '-ar', '44100',
      '-y',
      'output.wav'
    ]);
    wavData = await ffmpeg.readFile('output.wav') as Uint8Array;

    // Cleanup
    await ffmpeg.deleteFile(inputFile);
    await ffmpeg.deleteFile('output.mp3');
    await ffmpeg.deleteFile('output.wav');
  } else {
    throw new Error(`Unsupported audio format: ${sourceFormat}`);
  }

  // Create preview clip from MP3 (smaller file, faster processing)
  const previewData = await createPreviewClip(ffmpeg, mp3Data, 'mp3');

  // Generate safe filename from title
  const safeTitle = trackTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);

  // Upload to releases bucket
  const mp3Key = `releases/${releaseId}/tracks/${paddedNum}-${safeTitle}.mp3`;
  const wavKey = `releases/${releaseId}/tracks/${paddedNum}-${safeTitle}.wav`;
  const previewKey = `releases/${releaseId}/previews/${paddedNum}-preview.mp3`;

  console.log(`[Audio] Uploading processed files...`);

  await Promise.all([
    env.RELEASES_BUCKET.put(mp3Key, mp3Data, {
      httpMetadata: {
        contentType: 'audio/mpeg',
        cacheControl: 'public, max-age=31536000'
      }
    }),
    env.RELEASES_BUCKET.put(wavKey, wavData, {
      httpMetadata: {
        contentType: 'audio/wav',
        cacheControl: 'public, max-age=31536000'
      }
    }),
    env.RELEASES_BUCKET.put(previewKey, previewData, {
      httpMetadata: {
        contentType: 'audio/mpeg',
        cacheControl: 'public, max-age=31536000'
      }
    })
  ]);

  const mp3Url = `${env.R2_PUBLIC_DOMAIN}/${mp3Key}`;
  const wavUrl = `${env.R2_PUBLIC_DOMAIN}/${wavKey}`;
  const previewUrl = `${env.R2_PUBLIC_DOMAIN}/${previewKey}`;

  console.log(`[Audio] Track ${trackNumber} processed successfully`);
  console.log(`  MP3: ${mp3Url}`);
  console.log(`  WAV: ${wavUrl}`);
  console.log(`  Preview: ${previewUrl}`);

  return {
    trackNumber,
    title: trackTitle,
    mp3Url,
    wavUrl,
    previewUrl,
    bpm: trackMetadata.bpm,
    key: trackMetadata.key
  };
}
