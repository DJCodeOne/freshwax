// src/lib/releases.ts
// Fetches releases from Cloudinary master JSON - ONLY SHOWS PUBLISHED RELEASES
// FIXED: Using correct Cloudinary account (dscqbze0d) + Preview URL normalization

const CLOUDINARY_RELEASES_URL = 'https://res.cloudinary.com/dscqbze0d/raw/upload/releases/releases.json';

export interface Track {
  id: string;
  title: string;
  preview_url: string | null;
  track_number: number;
  url?: string; // R2 full audio URL
  previewUrl?: string; // Cloudinary preview URL
  storage?: string; // 'r2' or 'cloudinary-audio'
  previewStorage?: string;
}

export interface Release {
  id: string;
  title: string;
  artist: string;
  label?: string;
  artworkUrl: string;
  coverUrl?: string; // Alternative field name
  coverStorage?: string;
  releaseDate: string;
  isPreorder: boolean;
  hasVinyl: boolean;
  vinylStock?: number;
  digitalPrice: number;
  vinylPrice?: number;
  trackPrice?: number;
  tracks: Track[];
  fullTracks?: string[];
  extraNotes?: string;
  description?: string;
  genre?: string;
  createdAt?: string;
  updatedAt?: string;
  published?: boolean;
  publishedAt?: string;
}

/**
 * Fetches all PUBLISHED releases from Cloudinary master JSON
 * (Unpublished releases are filtered out for public viewing)
 * FIXED: Normalizes preview URLs to ensure waveforms work
 */
export async function getAllReleases(): Promise<Release[]> {
  try {
    // Add timestamp to bust cache
    const timestamp = Date.now();
    const url = `${CLOUDINARY_RELEASES_URL}?t=${timestamp}`;
    
    console.log('[getAllReleases] Fetching from:', url);
    
    const response = await fetch(url, {
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      }
    });

    if (!response.ok) {
      console.error(`[getAllReleases] Failed to fetch releases: ${response.status} ${response.statusText}`);
      return [];
    }

    const releases = await response.json();
    
    if (!Array.isArray(releases)) {
      console.error('[getAllReleases] Invalid releases data: expected array, got:', typeof releases);
      return [];
    }

    // Filter to only published releases for public viewing
    const publishedReleases = releases.filter(release => release.published === true);

    // CRITICAL FIX: Normalize track URLs - ensure preview_url is always set
    const normalizedReleases = publishedReleases.map(release => ({
      ...release,
      tracks: (release.tracks || []).map(track => {
        // The preview URL could be in either field, depending on upload source
        const previewUrl = track.preview_url || track.previewUrl || null;
        
        console.log(`[getAllReleases] Track: ${track.title} | preview_url: ${track.preview_url} | previewUrl: ${track.previewUrl} | normalized: ${previewUrl}`);
        
        return {
          ...track,
          // Ensure preview_url is always set (ReleasePlate expects this field)
          preview_url: previewUrl,
          // Keep previewUrl for backwards compatibility
          previewUrl: previewUrl
        };
      })
    }));

    console.log(`[getAllReleases] Loaded ${normalizedReleases.length} published releases (${releases.length} total in master JSON)`);
    
    // Log first release for debugging
    if (normalizedReleases.length > 0) {
      const firstRelease = normalizedReleases[0];
      console.log('[getAllReleases] First published release:', {
        id: firstRelease.id,
        title: firstRelease.title,
        artist: firstRelease.artist,
        published: firstRelease.published,
        tracks: firstRelease.tracks?.length || 0
      });
      
      // Log track preview URLs for debugging waveforms
      if (firstRelease.tracks && firstRelease.tracks.length > 0) {
        console.log('[getAllReleases] First track preview_url:', firstRelease.tracks[0].preview_url);
        console.log('[getAllReleases] First track full object:', firstRelease.tracks[0]);
      }
    } else {
      console.warn('[getAllReleases] No published releases found!');
      if (releases.length > 0) {
        console.warn('[getAllReleases] Found', releases.length, 'unpublished releases');
        console.warn('[getAllReleases] First unpublished release:', {
          id: releases[0].id,
          title: releases[0].title,
          published: releases[0].published
        });
      }
    }

    return normalizedReleases;
  } catch (error) {
    console.error('[getAllReleases] Error fetching releases from Cloudinary:', error);
    return [];
  }
}

/**
 * Gets featured releases (most recent published)
 * @param limit - Number of releases to return (default: 6)
 */
export async function getFeaturedReleases(limit: number = 6): Promise<Release[]> {
  const allReleases = await getAllReleases();
  
  // Sort by published date first, then creation date (newest first)
  const sorted = allReleases.sort((a, b) => {
    const dateA = new Date(a.publishedAt || a.createdAt || a.releaseDate || 0).getTime();
    const dateB = new Date(b.publishedAt || b.createdAt || b.releaseDate || 0).getTime();
    return dateB - dateA;
  });
  
  console.log(`[getFeaturedReleases] Returning ${Math.min(limit, sorted.length)} of ${sorted.length} releases`);
  
  return sorted.slice(0, limit);
}

/**
 * Gets releases for the releases page (published only)
 * @param limit - Number of releases to return (default: 20)
 */
export async function getReleasesForPage(limit: number = 20): Promise<Release[]> {
  const allReleases = await getAllReleases();
  
  // Sort by published date first, then creation date (newest first)
  const sorted = allReleases.sort((a, b) => {
    const dateA = new Date(a.publishedAt || a.createdAt || a.releaseDate || 0).getTime();
    const dateB = new Date(b.publishedAt || b.createdAt || b.releaseDate || 0).getTime();
    return dateB - dateA;
  });
  
  console.log(`[getReleasesForPage] Returning ${Math.min(limit, sorted.length)} of ${sorted.length} releases`);
  
  return sorted.slice(0, limit);
}

/**
 * Gets a single published release by ID
 */
export async function getReleaseById(id: string): Promise<Release | null> {
  const allReleases = await getAllReleases();
  const release = allReleases.find(release => release.id === id);
  
  if (release) {
    console.log(`[getReleaseById] Found release: ${id}`);
  } else {
    console.log(`[getReleaseById] Release not found: ${id}`);
  }
  
  return release || null;
}

/**
 * Filters published releases by artist
 */
export async function getReleasesByArtist(artist: string): Promise<Release[]> {
  const allReleases = await getAllReleases();
  return allReleases.filter(release => 
    release.artist.toLowerCase() === artist.toLowerCase()
  );
}

/**
 * Filters published releases by label
 */
export async function getReleasesByLabel(label: string): Promise<Release[]> {
  const allReleases = await getAllReleases();
  return allReleases.filter(release => 
    release.label?.toLowerCase() === label.toLowerCase()
  );
}

/**
 * Filters published releases by genre
 */
export async function getReleasesByGenre(genre: string): Promise<Release[]> {
  const allReleases = await getAllReleases();
  return allReleases.filter(release => 
    release.genre?.toLowerCase() === genre.toLowerCase()
  );
}

/**
 * Searches published releases by title or artist
 */
export async function searchReleases(query: string): Promise<Release[]> {
  const allReleases = await getAllReleases();
  const lowerQuery = query.toLowerCase();
  
  return allReleases.filter(release => 
    release.title.toLowerCase().includes(lowerQuery) ||
    release.artist.toLowerCase().includes(lowerQuery) ||
    release.label?.toLowerCase().includes(lowerQuery)
  );
}