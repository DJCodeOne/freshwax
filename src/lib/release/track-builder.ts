// src/lib/release/track-builder.ts
// Track metadata matching and track array construction extracted from process-release.ts

import type { createLogger } from '../api-utils';

export interface AudioFileInfo {
  oldKey: string;
  newKey: string;
  url: string;
}

export interface BuildTrackArrayParams {
  metadata: Record<string, unknown>;
  newAudioFiles: AudioFileInfo[];
  log: ReturnType<typeof createLogger>;
}

export interface BuildTrackArrayResult {
  tracks: Record<string, unknown>[];
  remainingAudioFiles: AudioFileInfo[];
}

// Helper to normalize names for matching (lowercase, remove special chars)
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Build tracks array by matching metadata tracks to audio files by name.
 * Returns matched tracks and any remaining unmatched audio files (also added as tracks).
 */
export function buildTrackArray(params: BuildTrackArrayParams): BuildTrackArrayResult {
  const { metadata, log } = params;
  let audioFiles = [...params.newAudioFiles];
  const tracks: Record<string, unknown>[] = [];

  // Parse tracks from metadata - try tracks array first, then trackListingJSON string
  let metadataTracks: Record<string, unknown>[] = [];
  if (metadata.tracks && Array.isArray(metadata.tracks)) {
    metadataTracks = metadata.tracks;
  } else if (metadata.trackListingJSON) {
    try {
      metadataTracks = JSON.parse(metadata.trackListingJSON as string);
    } catch (e: unknown) {
      log.warn('Failed to parse trackListingJSON:', e);
    }
  }

  log.debug(`Metadata tracks (${metadataTracks.length}):`, metadataTracks);
  log.debug(`Audio files:`, audioFiles);

  // For each metadata track, find the matching audio file from audioFiles
  for (let i = 0; i < metadataTracks.length; i++) {
    const metaTrack = metadataTracks[i];
    const trackName = (metaTrack.title || metaTrack.trackName || '') as string;
    const normalizedTrackName = normalize(trackName);

    log.debug(`Looking for audio file matching: "${trackName}"`);

    // Find audio file that contains this track name (from copied files)
    let matchedAudio = audioFiles.find(audioFile => {
      const filename = audioFile.newKey.split('/').pop() || '';
      const normalizedFilename = normalize(filename);
      return normalizedFilename.includes(normalizedTrackName) && normalizedTrackName.length > 2;
    });

    // If no match found, use first remaining audio file as fallback
    if (!matchedAudio && audioFiles.length > 0) {
      matchedAudio = audioFiles[0];
      log.debug(`No name match, using first remaining file: ${matchedAudio.newKey}`);
    }

    if (!matchedAudio) {
      log.warn(`No audio file found for track ${i + 1}: ${trackName}`);
      continue;
    }

    // Use the URL from the copied file (already in releases folder)
    const audioUrl = matchedAudio.url;

    log.debug(`Track ${i + 1}: "${trackName}" -> ${matchedAudio.newKey}`);

    tracks.push({
      trackNumber: metaTrack.trackNumber || i + 1,
      title: trackName || `Track ${i + 1}`,
      trackName: trackName || `Track ${i + 1}`,
      mp3Url: audioUrl,
      wavUrl: audioUrl,
      previewUrl: audioUrl,
      bpm: metaTrack.bpm || '',
      key: metaTrack.key || '',
      duration: metaTrack.duration || '',
      trackISRC: metaTrack.trackISRC || '',
      featured: metaTrack.featured || '',
      remixer: metaTrack.remixer || '',
      storage: 'r2'
    });

    // Remove matched file from list to prevent duplicates
    audioFiles = audioFiles.filter(f => f !== matchedAudio);
  }

  // Add any remaining unmatched audio files
  for (let i = 0; i < audioFiles.length; i++) {
    const audioFile = audioFiles[i];
    const filename = audioFile.newKey.split('/').pop() || '';
    const trackNameFromFile = filename
      .replace(/\.(wav|mp3|flac)$/i, '')
      .replace(/^\d+[\s._-]+/, '')
      .trim();

    const audioUrl = audioFile.url;

    log.debug(`Unmatched track: "${trackNameFromFile}" -> ${filename}`);

    tracks.push({
      trackNumber: tracks.length + 1,
      title: trackNameFromFile || `Track ${tracks.length + 1}`,
      trackName: trackNameFromFile || `Track ${tracks.length + 1}`,
      mp3Url: audioUrl,
      wavUrl: audioUrl,
      previewUrl: audioUrl,
      bpm: '',
      key: '',
      duration: '',
      trackISRC: '',
      featured: '',
      remixer: '',
      storage: 'r2'
    });
  }

  return { tracks, remainingAudioFiles: audioFiles };
}
