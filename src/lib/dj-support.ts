// src/lib/dj-support.ts
// DJ support tracking — links DJ mixes to catalog releases they play/support.
// Supports both automated tracklist scanning and manual curation.

import { createLogger } from './api-utils';

const logger = createLogger('dj-support');

// ============================================
// TYPES
// ============================================

export interface DjSupportInput {
  mixId: string;
  releaseId: string;
  djUserId?: string | null;
  djName: string;
  releaseTitle: string;
  artistName: string;
  source: 'tracklist_scan' | 'manual';
  confidence?: number;
}

export interface DjSupportRow {
  id: string;
  mixId: string;
  releaseId: string;
  djUserId: string | null;
  djName: string;
  releaseTitle: string;
  artistName: string;
  source: 'tracklist_scan' | 'manual';
  confidence: number;
  createdAt: string;
}

interface D1ReleaseRow {
  id: string;
  title: string;
  artist_name: string;
}

export interface ScanResult {
  matched: number;
  total: number;
}

// ============================================
// HELPERS
// ============================================

/**
 * Normalize a string for fuzzy comparison.
 * Lowercases, trims, strips "dj " prefix, and removes punctuation.
 */
function normalizeString(input: string): string {
  let s = input.toLowerCase().trim();
  // Remove common "dj " prefix
  s = s.replace(/^dj\s+/i, '');
  // Remove punctuation (keep alphanumeric and spaces)
  s = s.replace(/[^\w\s]/g, '');
  // Collapse multiple spaces
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Map a raw D1 row to a typed DjSupportRow.
 */
function mapRow(row: Record<string, unknown>): DjSupportRow {
  return {
    id: row.id as string,
    mixId: row.mix_id as string,
    releaseId: row.release_id as string,
    djUserId: (row.dj_user_id as string) || null,
    djName: row.dj_name as string,
    releaseTitle: row.release_title as string,
    artistName: row.artist_name as string,
    source: row.source as 'tracklist_scan' | 'manual',
    confidence: row.confidence as number,
    createdAt: row.created_at as string,
  };
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Insert a DJ-to-release support link.
 * Uses INSERT OR IGNORE to prevent duplicates on the mix_id + release_id pair.
 * Returns true if a row was inserted, false if duplicate or error.
 */
export async function addDjSupport(db: D1Database, support: DjSupportInput): Promise<boolean> {
  const id = support.mixId + '_' + support.releaseId;
  const confidence = support.confidence ?? 1.0;
  const now = new Date().toISOString();

  try {
    const result = await db.prepare(
      `INSERT OR IGNORE INTO dj_support (id, mix_id, release_id, dj_user_id, dj_name, release_title, artist_name, source, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      support.mixId,
      support.releaseId,
      support.djUserId ?? null,
      support.djName,
      support.releaseTitle,
      support.artistName,
      support.source,
      confidence,
      now
    ).run();

    const inserted = (result?.meta?.changes ?? 0) > 0;
    if (inserted) {
      logger.info(`Added support: ${support.djName} -> ${support.releaseTitle} (${support.source}, confidence ${confidence})`);
    }
    return inserted;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to add support for mix ${support.mixId} -> release ${support.releaseId}: ${message}`);
    return false;
  }
}

/**
 * Remove a manual support entry.
 * Only deletes entries where source = 'manual' to protect automated scan results.
 * Returns true if a row was deleted.
 */
export async function removeDjSupport(db: D1Database, mixId: string, releaseId: string): Promise<boolean> {
  const id = mixId + '_' + releaseId;

  try {
    const result = await db.prepare(
      `DELETE FROM dj_support WHERE id = ? AND source = 'manual'`
    ).bind(id).run();

    const deleted = (result?.meta?.changes ?? 0) > 0;
    if (deleted) {
      logger.info(`Removed manual support: ${id}`);
    }
    return deleted;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to remove support ${id}: ${message}`);
    return false;
  }
}

/**
 * Get all DJs who support a given release, ordered by most recent first.
 */
export async function getSupportersForRelease(db: D1Database, releaseId: string): Promise<DjSupportRow[]> {
  try {
    const { results } = await db.prepare(
      `SELECT id, mix_id, release_id, dj_user_id, dj_name, release_title, artist_name, source, confidence, created_at
       FROM dj_support
       WHERE release_id = ?
       ORDER BY created_at DESC`
    ).bind(releaseId).all();

    return (results ?? []).map((row) => mapRow(row as Record<string, unknown>));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to get supporters for release ${releaseId}: ${message}`);
    return [];
  }
}

/**
 * Get all release matches for a given mix, ordered by highest confidence first.
 */
export async function getSupportsForMix(db: D1Database, mixId: string): Promise<DjSupportRow[]> {
  try {
    const { results } = await db.prepare(
      `SELECT id, mix_id, release_id, dj_user_id, dj_name, release_title, artist_name, source, confidence, created_at
       FROM dj_support
       WHERE mix_id = ?
       ORDER BY confidence DESC`
    ).bind(mixId).all();

    return (results ?? []).map((row) => mapRow(row as Record<string, unknown>));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to get supports for mix ${mixId}: ${message}`);
    return [];
  }
}

/**
 * Scan tracklist lines against the catalog and insert support entries for matches.
 *
 * Each tracklist line is split on " - " to extract artist and title. Matching is
 * done against all published releases in d1_releases:
 *   - Exact match on both artist AND title (case-insensitive) = confidence 1.0
 *   - Artist matches exactly AND title contains release title (or vice versa) = confidence 0.7
 *
 * Only entries with confidence >= 0.7 are inserted.
 */
export async function scanTracklistForSupport(
  db: D1Database,
  mixId: string,
  djUserId: string | null,
  djName: string,
  tracklistLines: string[]
): Promise<ScanResult> {
  let matched = 0;
  const total = tracklistLines.length;

  try {
    // Step 1: Load all published releases
    const { results } = await db.prepare(
      `SELECT id, title, artist_name FROM d1_releases WHERE status = 'live'`
    ).all();

    const releases = (results ?? []) as unknown as D1ReleaseRow[];

    if (releases.length === 0) {
      logger.info('No published releases found — skipping tracklist scan');
      return { matched: 0, total };
    }

    // Pre-normalize release data for comparison
    const normalizedReleases = releases.map((r) => ({
      id: r.id,
      title: r.title,
      artistName: r.artist_name,
      normTitle: normalizeString(r.title),
      normArtist: normalizeString(r.artist_name),
    }));

    // Step 2-4: Match each tracklist line against releases
    for (const line of tracklistLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Try to split on " - " to get artist and title
      const sepIndex = trimmed.indexOf(' - ');
      if (sepIndex === -1) continue;

      const lineArtist = normalizeString(trimmed.substring(0, sepIndex));
      const lineTitle = normalizeString(trimmed.substring(sepIndex + 3));

      if (!lineArtist || !lineTitle) continue;

      // Find best match across all releases
      let bestMatch: { releaseId: string; releaseTitle: string; artistName: string; confidence: number } | null = null;

      for (const release of normalizedReleases) {
        let confidence = 0;

        if (lineArtist === release.normArtist && lineTitle === release.normTitle) {
          // Exact match on both
          confidence = 1.0;
        } else if (
          lineArtist === release.normArtist &&
          (lineTitle.includes(release.normTitle) || release.normTitle.includes(lineTitle))
        ) {
          // Artist exact, title partial
          confidence = 0.7;
        } else if (
          lineTitle === release.normTitle &&
          (lineArtist.includes(release.normArtist) || release.normArtist.includes(lineArtist))
        ) {
          // Title exact, artist partial
          confidence = 0.7;
        }

        if (confidence >= 0.7 && (!bestMatch || confidence > bestMatch.confidence)) {
          bestMatch = {
            releaseId: release.id,
            releaseTitle: release.title,
            artistName: release.artistName,
            confidence,
          };
        }

        // No need to keep searching if we found a perfect match
        if (confidence === 1.0) break;
      }

      // Step 5: Insert match if confidence threshold met
      if (bestMatch) {
        const inserted = await addDjSupport(db, {
          mixId,
          releaseId: bestMatch.releaseId,
          djUserId,
          djName,
          releaseTitle: bestMatch.releaseTitle,
          artistName: bestMatch.artistName,
          source: 'tracklist_scan',
          confidence: bestMatch.confidence,
        });

        if (inserted) {
          matched++;
        }
      }
    }

    logger.info(`Tracklist scan for mix ${mixId}: ${matched}/${total} lines matched`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Tracklist scan failed for mix ${mixId}: ${message}`);
  }

  return { matched, total };
}
