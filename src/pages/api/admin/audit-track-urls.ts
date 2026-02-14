// src/pages/api/admin/audit-track-urls.ts
// TEMPORARY audit endpoint - checks all releases for track URL issues

import type { APIRoute } from 'astro';
import { queryCollection } from '../../../lib/firebase-rest';

export const prerender = false;

/**
 * Extract a simplified filename from a URL for comparison with track name.
 * e.g., "https://r2.freshwax.co.uk/releases/abc/02-mispent-youth.mp3" -> "mispent youth"
 */
function extractFilenameFromUrl(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    const filename = path.split('/').pop() || '';
    // Remove extension
    const withoutExt = filename.replace(/\.(mp3|wav|m4a|flac|ogg|aac)$/i, '');
    // Remove leading track number prefix like "01-" or "01_" or "1-"
    const withoutTrackNum = withoutExt.replace(/^\d+[-_]\s*/, '');
    // Replace hyphens/underscores with spaces, lowercase
    return withoutTrackNum.replace(/[-_]/g, ' ').toLowerCase().trim();
  } catch {
    return null;
  }
}

/**
 * Normalize a track name for comparison.
 * Lowercases, removes punctuation, trims.
 */
function normalizeTrackName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[''""()[\]{}.,:;!?&]/g, '')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if a track name reasonably matches a filename extracted from a URL.
 * Uses a loose check: the normalized filename should contain the normalized name or vice versa.
 */
function namesMatch(trackName: string, filenameFromUrl: string): boolean {
  const normName = normalizeTrackName(trackName);
  const normFile = filenameFromUrl; // already normalized by extractFilenameFromUrl

  if (!normName || !normFile) return true; // Can't compare, skip

  // Exact match
  if (normName === normFile) return true;

  // One contains the other
  if (normFile.includes(normName) || normName.includes(normFile)) return true;

  // Check if significant words from track name appear in filename
  const nameWords = normName.split(' ').filter(w => w.length > 2);
  if (nameWords.length === 0) return true; // Very short name, skip
  const matchingWords = nameWords.filter(w => normFile.includes(w));
  // If at least half the significant words match, consider it a match
  return matchingWords.length >= Math.ceil(nameWords.length / 2);
}

interface TrackIssue {
  trackIndex: number;
  trackName: string;
  issue: string;
  details?: string;
}

interface ReleaseAudit {
  releaseId: string;
  releaseTitle: string;
  artistName: string;
  trackCount: number;
  issues: TrackIssue[];
}

export const GET: APIRoute = async ({ request, locals }) => {
  // No auth - temporary audit endpoint
  try {
    // Fetch all releases (skip cache to get fresh data)
    const releases = await queryCollection('releases', {
      limit: 500,
      skipCache: true,
    });

    const report: ReleaseAudit[] = [];
    let totalIssues = 0;

    for (const release of releases) {
      const releaseId = release.id || release._id || 'unknown';
      const releaseTitle = release.releaseName || release.title || 'Untitled';
      const artistName = release.artistName || release.artist || 'Unknown';
      const tracks: any[] = release.tracks || [];

      if (tracks.length === 0) continue;

      const issues: TrackIssue[] = [];

      // Collect all URLs across tracks for duplicate detection
      const urlMap: Map<string, { trackIndex: number; trackName: string; urlType: string }[]> = new Map();

      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        const trackName = track.name || track.title || `Track ${i + 1}`;

        // Check for missing URLs
        const previewUrl = track.previewUrl;
        const mp3Url = track.mp3Url;
        const wavUrl = track.wavUrl;

        if (!previewUrl) {
          issues.push({
            trackIndex: i,
            trackName,
            issue: 'MISSING_PREVIEW_URL',
            details: 'previewUrl is ' + (previewUrl === null ? 'null' : previewUrl === undefined ? 'undefined' : 'empty string'),
          });
        }

        if (!mp3Url) {
          issues.push({
            trackIndex: i,
            trackName,
            issue: 'MISSING_MP3_URL',
            details: 'mp3Url is ' + (mp3Url === null ? 'null' : mp3Url === undefined ? 'undefined' : 'empty string'),
          });
        }

        if (!wavUrl) {
          issues.push({
            trackIndex: i,
            trackName,
            issue: 'MISSING_WAV_URL',
            details: 'wavUrl is ' + (wavUrl === null ? 'null' : wavUrl === undefined ? 'undefined' : 'empty string'),
          });
        }

        // Track URLs for duplicate detection
        for (const [urlType, urlValue] of [['previewUrl', previewUrl], ['mp3Url', mp3Url], ['wavUrl', wavUrl]] as const) {
          if (urlValue && typeof urlValue === 'string' && urlValue.trim()) {
            const normalizedUrl = urlValue.trim();
            if (!urlMap.has(normalizedUrl)) {
              urlMap.set(normalizedUrl, []);
            }
            urlMap.get(normalizedUrl)!.push({ trackIndex: i, trackName, urlType: urlType as string });
          }
        }

        // Check track name vs filename mismatch
        for (const [urlType, urlValue] of [['previewUrl', previewUrl], ['mp3Url', mp3Url], ['wavUrl', wavUrl]] as const) {
          if (urlValue && typeof urlValue === 'string' && urlValue.trim()) {
            const filenameFromUrl = extractFilenameFromUrl(urlValue);
            if (filenameFromUrl && !namesMatch(trackName, filenameFromUrl)) {
              issues.push({
                trackIndex: i,
                trackName,
                issue: 'NAME_URL_MISMATCH',
                details: `${urlType} filename "${filenameFromUrl}" does not match track name "${trackName}"`,
              });
            }
          }
        }
      }

      // Check for duplicate URLs across different tracks
      for (const [url, entries] of urlMap) {
        // Group by track index - only flag if the same URL appears on DIFFERENT tracks
        const uniqueTracks = new Map<number, typeof entries>();
        for (const entry of entries) {
          if (!uniqueTracks.has(entry.trackIndex)) {
            uniqueTracks.set(entry.trackIndex, []);
          }
          uniqueTracks.get(entry.trackIndex)!.push(entry);
        }

        if (uniqueTracks.size > 1) {
          // Same URL used by multiple different tracks
          const trackDescriptions = Array.from(uniqueTracks.entries())
            .map(([idx, e]) => `Track ${idx + 1} ("${e[0].trackName}") ${e.map(x => x.urlType).join(', ')}`)
            .join(' & ');

          // Add issue to the second (and later) tracks that share this URL
          const trackIndices = Array.from(uniqueTracks.keys()).sort((a, b) => a - b);
          for (let t = 1; t < trackIndices.length; t++) {
            const idx = trackIndices[t];
            const trackEntries = uniqueTracks.get(idx)!;
            issues.push({
              trackIndex: idx,
              trackName: trackEntries[0].trackName,
              issue: 'DUPLICATE_URL',
              details: `URL shared between: ${trackDescriptions}. URL: ${url}`,
            });
          }
        }
      }

      if (issues.length > 0) {
        report.push({
          releaseId,
          releaseTitle,
          artistName,
          trackCount: tracks.length,
          issues,
        });
        totalIssues += issues.length;
      }
    }

    // Sort report: releases with more issues first
    report.sort((a, b) => b.issues.length - a.issues.length);

    return new Response(JSON.stringify({
      summary: {
        totalReleasesScanned: releases.length,
        releasesWithIssues: report.length,
        totalIssues,
        issueBreakdown: {
          missingPreviewUrl: report.reduce((sum, r) => sum + r.issues.filter(i => i.issue === 'MISSING_PREVIEW_URL').length, 0),
          missingMp3Url: report.reduce((sum, r) => sum + r.issues.filter(i => i.issue === 'MISSING_MP3_URL').length, 0),
          missingWavUrl: report.reduce((sum, r) => sum + r.issues.filter(i => i.issue === 'MISSING_WAV_URL').length, 0),
          duplicateUrls: report.reduce((sum, r) => sum + r.issues.filter(i => i.issue === 'DUPLICATE_URL').length, 0),
          nameUrlMismatch: report.reduce((sum, r) => sum + r.issues.filter(i => i.issue === 'NAME_URL_MISMATCH').length, 0),
        },
      },
      releases: report,
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({
      error: 'Audit failed',
      message,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
