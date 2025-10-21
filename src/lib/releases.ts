// src/lib/releases.ts

export interface Track {
  id: string;
  title: string;
  preview_url: string | null;
  track_number: number;
  price: number;
  wav_url?: string;
  mp3_url?: string;
}

export interface Release {
  id: string;
  title: string;
  artist: string;
  label?: string;
  artworkUrl: string;
  releaseDate: string;
  isPreorder: boolean;
  hasVinyl: boolean;
  vinylStock?: number;
  digitalPrice: number;
  vinylPrice?: number;
  tracks: Track[];
  extraNotes?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
}

// src/lib/releases.ts

export interface Track {
  id: string;
  title: string;
  preview_url: string | null;
  track_number: number;
  price: number;
  wav_url?: string;
  mp3_url?: string;
}

export interface Release {
  id: string;
  title: string;
  artist: string;
  label?: string;
  artworkUrl: string;
  releaseDate: string;
  isPreorder: boolean;
  hasVinyl: boolean;
  vinylStock?: number;
  digitalPrice: number;
  vinylPrice?: number;
  tracks: Track[];
  extraNotes?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Get all releases from the JSON file
 */
export async function getAllReleases(): Promise<Release[]> {
  try {
    // Read directly from the file system (server-side)
    if (typeof window === 'undefined') {
      // Server-side: read from file
      const fs = await import('fs/promises');
      const path = await import('path');
      
      const filePath = path.join(process.cwd(), 'public', 'data', 'releases.json');
      
      try {
        const fileContent = await fs.readFile(filePath, 'utf-8');
        const data = JSON.parse(fileContent);
        return data.releases || [];
      } catch (err) {
        console.log('No releases.json file found or file is empty');
        return [];
      }
    } else {
      // Client-side: fetch from public folder
      const response = await fetch('/data/releases.json');
      if (!response.ok) {
        console.error('Failed to fetch releases');
        return [];
      }
      
      const data = await response.json();
      return data.releases || [];
    }
  } catch (error) {
    console.error('Error loading releases:', error);
    return [];
  }
}

/**
 * Get a single release by ID
 */
export async function getReleaseById(id: string): Promise<Release | null> {
  const releases = await getAllReleases();
  return releases.find(r => r.id === id) || null;
}

/**
 * Get featured/latest releases (for homepage)
 */
export async function getFeaturedReleases(limit: number = 6): Promise<Release[]> {
  const releases = await getAllReleases();
  
  // Sort by release date (newest first)
  const sorted = releases.sort((a, b) => {
    const dateA = new Date(a.releaseDate).getTime();
    const dateB = new Date(b.releaseDate).getTime();
    return dateB - dateA;
  });
  
  return sorted.slice(0, limit);
}

/**
 * Get releases by artist
 */
export async function getReleasesByArtist(artist: string): Promise<Release[]> {
  const releases = await getAllReleases();
  return releases.filter(r => 
    r.artist.toLowerCase() === artist.toLowerCase()
  );
}

/**
 * Get releases by label
 */
export async function getReleasesByLabel(label: string): Promise<Release[]> {
  const releases = await getAllReleases();
  return releases.filter(r => 
    r.label?.toLowerCase() === label.toLowerCase()
  );
}

/**
 * Search releases by title or artist
 */
export async function searchReleases(query: string): Promise<Release[]> {
  const releases = await getAllReleases();
  const lowerQuery = query.toLowerCase();
  
  return releases.filter(r => 
    r.title.toLowerCase().includes(lowerQuery) ||
    r.artist.toLowerCase().includes(lowerQuery) ||
    r.label?.toLowerCase().includes(lowerQuery)
  );
}

/**
 * Get available vinyl releases only
 */
export async function getVinylReleases(): Promise<Release[]> {
  const releases = await getAllReleases();
  return releases.filter(r => r.hasVinyl && (r.vinylStock ?? 0) > 0);
}

/**
 * Get preorder releases
 */
export async function getPreorderReleases(): Promise<Release[]> {
  const releases = await getAllReleases();
  return releases.filter(r => r.isPreorder);
}

/**
 * Generate a URL-friendly ID from a title
 */
export function generateReleaseId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}