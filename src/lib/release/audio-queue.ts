// Which releases still need their audio converting, and how to merge the
// results back in.
//
// Conversion cannot run in a Worker (no ffmpeg, 128MB memory, 70MB source
// files), so it is done by the local audio-processor service. This module is
// the shared vocabulary between the two: the Worker publishes a queue, the
// local agent drains it.

const WEB_READY_AUDIO = /\.mp3(\?|$)/i;
const RAW_AUDIO = /\.(wav|aiff?|flac|alac)(\?|$)/i;

export interface QueuedTrack {
  trackNumber: number;
  title: string;
  /** R2 key of the raw master to convert. */
  sourceKey: string;
  sourceUrl: string;
}

export interface QueuedRelease {
  releaseId: string;
  title: string;
  artistName: string;
  status: string;
  /** R2 folder the converted files belong in. */
  releaseFolder: string;
  tracks: QueuedTrack[];
}

/** True when this URL is a raw master the storefront should not be serving. */
export function isRawMaster(url: unknown): boolean {
  return typeof url === 'string' && RAW_AUDIO.test(url);
}

export function isWebReady(url: unknown): boolean {
  return typeof url === 'string' && WEB_READY_AUDIO.test(url);
}

/** Strip the CDN origin to get the R2 object key. */
export function urlToKey(url: string, publicDomain: string): string {
  const base = publicDomain.replace(/\/$/, '');
  const stripped = url.startsWith(base) ? url.slice(base.length) : new URL(url).pathname;
  return decodeURIComponent(stripped.replace(/^\//, ''));
}

/**
 * Find every track whose playable URL is still a raw master.
 *
 * Both `mp3Url` (what a buyer downloads) and `previewUrl` (what the storefront
 * streams) are checked — they drift apart independently, and a release with a
 * good mp3Url but a .wav previewUrl still streams a 70MB file to every visitor.
 */
export function buildAudioQueue(
  releases: Array<Record<string, unknown>>,
  publicDomain: string
): QueuedRelease[] {
  const queue: QueuedRelease[] = [];

  for (const release of releases) {
    const tracks = Array.isArray(release.tracks) ? (release.tracks as Record<string, unknown>[]) : [];
    if (tracks.length === 0) continue;

    const needing: QueuedTrack[] = [];
    tracks.forEach((t, i) => {
      const mp3 = String(t.mp3Url || t.url || '');
      const preview = String(t.previewUrl || '');
      const wav = String(t.wavUrl || '');

      // Nothing to do when both playable URLs are already MP3.
      if (isWebReady(mp3) && (!preview || isWebReady(preview))) return;

      // Prefer an explicit raw master; otherwise whichever URL is still raw.
      const source = [wav, mp3, preview].find(u => isRawMaster(u));
      if (!source) return;

      needing.push({
        trackNumber: Number(t.trackNumber ?? i + 1),
        title: String(t.title || t.trackName || `Track ${i + 1}`),
        sourceKey: urlToKey(source, publicDomain),
        sourceUrl: source,
      });
    });

    if (needing.length === 0) continue;

    queue.push({
      releaseId: String(release.id),
      title: String(release.title || release.releaseName || ''),
      artistName: String(release.artistName || release.artist || ''),
      status: String(release.status || ''),
      releaseFolder: String(release.r2FolderPath || `releases/${release.id}`),
      tracks: needing,
    });
  }

  return queue;
}

export interface ConvertedTrack {
  trackNumber: number;
  mp3Url: string;
  previewUrl?: string;
  wavUrl?: string;
  duration?: string;
}

/**
 * Merge conversion results into the existing track array, matched on
 * trackNumber. Only URL/duration fields are touched — all other track metadata
 * (bpm, key, ISRC, remixer…) is preserved, and a result is ignored unless it
 * actually supplies an .mp3, so a bad agent response can never downgrade a
 * working track.
 */
export function mergeConvertedTracks(
  existing: Array<Record<string, unknown>>,
  converted: ConvertedTrack[]
): { tracks: Array<Record<string, unknown>>; updated: number } {
  const byNumber = new Map(converted.map(c => [Number(c.trackNumber), c]));
  let updated = 0;

  const tracks = existing.map((t, i) => {
    const key = Number(t.trackNumber ?? i + 1);
    const c = byNumber.get(key);
    if (!c || !isWebReady(c.mp3Url)) return t;

    updated++;
    return {
      ...t,
      mp3Url: c.mp3Url,
      previewUrl: isWebReady(c.previewUrl) ? c.previewUrl : c.mp3Url,
      // Keep the existing master unless the agent reports a different one.
      wavUrl: c.wavUrl || t.wavUrl || '',
      ...(c.duration ? { duration: c.duration } : {}),
    };
  });

  return { tracks, updated };
}
