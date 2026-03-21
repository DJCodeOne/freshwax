// src/lib/releases.ts
// Release data normalization helpers
// NOTE: Query functions (getAllReleases, getReleaseById, etc.) were removed
// because all catalog queries now go through D1 (see d1-catalog.ts / d1/releases.ts).

// Helper function to get label from release data
function getLabelFromRelease(release: Record<string, unknown>): string {
  return (release.labelName ||
         release.label ||
         release.recordLabel ||
         release.copyrightHolder ||
         'Unknown Label') as string;
}

// Helper function to normalize ratings data
function normalizeRatings(data: Record<string, unknown>): { average: number; count: number; total: number; fiveStarCount?: number } {
  const ratings = (data.ratings || data.overallRating || {}) as Record<string, unknown>;

  return {
    average: Number(ratings.average) || 0,
    count: Number(ratings.count) || 0,
    total: Number(ratings.total) || 0,
    fiveStarCount: Number(ratings.fiveStarCount) || 0
  };
}

// Helper function to normalize a single release document
export function normalizeRelease(data: Record<string, unknown>, id?: string): Record<string, unknown> | null {
  if (!data) return null;

  const normalizedRatings = normalizeRatings(data);

  return {
    ...(id ? { id } : {}),
    ...data,
    label: getLabelFromRelease(data),
    ratings: normalizedRatings,
    overallRating: normalizedRatings, // Backward compatibility
    tracks: ((data.tracks || []) as Record<string, unknown>[]).map((track, index: number) => ({
      ...track,
      trackNumber: track.trackNumber || track.displayTrackNumber || (index + 1),
      displayTrackNumber: track.displayTrackNumber || track.trackNumber || (index + 1),
      previewUrl: track.previewUrl || track.preview_url || track.mp3Url || null,
      duration: track.duration || null,
      ratings: track.ratings ? {
        average: Number(track.ratings.average) || 0,
        count: Number(track.ratings.count) || 0,
        total: Number(track.ratings.total) || 0
      } : undefined
    }))
  };
}
