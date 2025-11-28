// src/lib/releases.ts
// Uses Firebase Admin directly during SSR
// OPTIMIZED: Ensures ratings are always included to eliminate client-side batch API calls

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

// Helper function to get label from release data
function getLabelFromRelease(release: any): string {
  return release.labelName || 
         release.label || 
         release.recordLabel || 
         release.copyrightHolder || 
         'Unknown Label';
}

// Helper function to normalize ratings data
function normalizeRatings(data: any): { average: number; count: number; total: number } {
  // Check multiple possible rating field locations
  const ratings = data.ratings || data.overallRating || {};
  
  return {
    average: Number(ratings.average) || 0,
    count: Number(ratings.count) || 0,
    total: Number(ratings.total) || 0
  };
}

// Helper function to normalize a single release document
function normalizeRelease(doc: FirebaseFirestore.DocumentSnapshot): any {
  const data = doc.data();
  if (!data) return null;
  
  return {
    id: doc.id,
    ...data,
    // Ensure label field is consistent
    label: getLabelFromRelease(data),
    // Ensure ratings are always present with defaults
    // This eliminates the need for client-side batch API calls
    ratings: normalizeRatings(data),
    // Normalize tracks to ensure preview URLs are accessible
    tracks: (data.tracks || []).map((track: any, index: number) => ({
      ...track,
      trackNumber: track.trackNumber || track.displayTrackNumber || (index + 1),
      displayTrackNumber: track.displayTrackNumber || track.trackNumber || (index + 1),
      previewUrl: track.previewUrl || track.preview_url || track.mp3Url || null,
      duration: track.duration || null,
      // Include track-level ratings if present
      ratings: track.ratings ? {
        average: Number(track.ratings.average) || 0,
        count: Number(track.ratings.count) || 0,
        total: Number(track.ratings.total) || 0
      } : undefined
    }))
  };
}

export async function getAllReleases(): Promise<any[]> {
  try {
    const snapshot = await db.collection('releases')
      .where('status', '==', 'live')
      .get();
    
    const releases: any[] = [];
    
    snapshot.forEach(doc => {
      const normalized = normalizeRelease(doc);
      if (normalized) {
        releases.push(normalized);
      }
    });
    
    console.log(`[getAllReleases] Returning ${releases.length} releases`);
    
    // Debug log first release
    if (releases.length > 0) {
      console.log('[getAllReleases] First release:', {
        id: releases[0].id,
        label: releases[0].label,
        ratings: releases[0].ratings,
        trackCount: releases[0].tracks?.length || 0
      });
    }
    
    return releases;
  } catch (error) {
    console.error('[getAllReleases] Error:', error);
    return [];
  }
}

export async function getReleasesForPage(limit: number = 20): Promise<any[]> {
  try {
    // Try to use an indexed query first for better performance
    const snapshot = await db.collection('releases')
      .where('status', '==', 'live')
      .orderBy('releaseDate', 'desc')
      .limit(limit)
      .get();
    
    const releases: any[] = [];
    
    snapshot.forEach(doc => {
      const normalized = normalizeRelease(doc);
      if (normalized) {
        releases.push(normalized);
      }
    });
    
    console.log(`[getReleasesForPage] Returning ${releases.length} releases (limit: ${limit})`);
    return releases;
    
  } catch (error) {
    // Fallback to getAllReleases if index doesn't exist
    console.warn('[getReleasesForPage] Indexed query failed, falling back to getAllReleases:', error);
    const all = await getAllReleases();
    return all
      .sort((a, b) => new Date(b.releaseDate).getTime() - new Date(a.releaseDate).getTime())
      .slice(0, limit);
  }
}

export async function getReleaseById(id: string): Promise<any | null> {
  try {
    console.log(`[getReleaseById] Fetching: ${id}`);
    const doc = await db.collection('releases').doc(id).get();
    
    if (!doc.exists) {
      console.log(`[getReleaseById] ✗ Not found: ${id}`);
      return null;
    }
    
    const data = doc.data();
    console.log(`[getReleaseById] Found, status: ${data?.status}`);
    
    if (!data || data.status !== 'live') {
      console.log(`[getReleaseById] ✗ Status not live: ${id}`);
      return null;
    }
    
    const result = normalizeRelease(doc);
    
    console.log(`[getReleaseById] ✓ Returning:`, {
      id: result.id,
      artistName: result.artistName,
      releaseName: result.releaseName,
      label: result.label,
      ratings: result.ratings,
      coverArtUrl: result.coverArtUrl?.substring(0, 50)
    });
    
    return result;
  } catch (error) {
    console.error(`[getReleaseById] Error:`, error);
    return null;
  }
}

export async function getReleasesGroupedByLabel(): Promise<Record<string, any[]>> {
  try {
    console.log('[getReleasesGroupedByLabel] Fetching and grouping releases');
    const releases = await getAllReleases();
    const releasesByLabel: Record<string, any[]> = {};
    
    releases.forEach(release => {
      const label = release.label || getLabelFromRelease(release);
      
      if (!releasesByLabel[label]) {
        releasesByLabel[label] = [];
      }
      releasesByLabel[label].push(release);
    });
    
    // Sort each label's releases by date (newest first)
    Object.keys(releasesByLabel).forEach(label => {
      releasesByLabel[label].sort((a, b) => {
        const dateA = new Date(a.releaseDate || 0).getTime();
        const dateB = new Date(b.releaseDate || 0).getTime();
        return dateB - dateA;
      });
    });
    
    console.log(`[getReleasesGroupedByLabel] ✓ Grouped ${releases.length} releases into ${Object.keys(releasesByLabel).length} labels`);
    
    // Log label breakdown
    Object.keys(releasesByLabel).forEach(label => {
      console.log(`  - ${label}: ${releasesByLabel[label].length} releases`);
    });
    
    return releasesByLabel;
  } catch (error) {
    console.error('[getReleasesGroupedByLabel] Error:', error);
    return {};
  }
}

// New helper: Get releases by artist name
export async function getReleasesByArtist(artistName: string): Promise<any[]> {
  try {
    const snapshot = await db.collection('releases')
      .where('status', '==', 'live')
      .where('artistName', '==', artistName)
      .get();
    
    const releases: any[] = [];
    
    snapshot.forEach(doc => {
      const normalized = normalizeRelease(doc);
      if (normalized) {
        releases.push(normalized);
      }
    });
    
    // Sort by release date
    releases.sort((a, b) => new Date(b.releaseDate).getTime() - new Date(a.releaseDate).getTime());
    
    console.log(`[getReleasesByArtist] Found ${releases.length} releases for "${artistName}"`);
    return releases;
  } catch (error) {
    console.error('[getReleasesByArtist] Error:', error);
    return [];
  }
}

// New helper: Get releases by label
export async function getReleasesByLabel(labelName: string): Promise<any[]> {
  try {
    // Query multiple possible label fields
    const queries = [
      db.collection('releases').where('status', '==', 'live').where('labelName', '==', labelName).get(),
      db.collection('releases').where('status', '==', 'live').where('recordLabel', '==', labelName).get(),
      db.collection('releases').where('status', '==', 'live').where('copyrightHolder', '==', labelName).get()
    ];
    
    const snapshots = await Promise.all(queries);
    const releaseMap = new Map<string, any>();
    
    snapshots.forEach(snapshot => {
      snapshot.forEach(doc => {
        if (!releaseMap.has(doc.id)) {
          const normalized = normalizeRelease(doc);
          if (normalized) {
            releaseMap.set(doc.id, normalized);
          }
        }
      });
    });
    
    const releases = Array.from(releaseMap.values());
    releases.sort((a, b) => new Date(b.releaseDate).getTime() - new Date(a.releaseDate).getTime());
    
    console.log(`[getReleasesByLabel] Found ${releases.length} releases for "${labelName}"`);
    return releases;
  } catch (error) {
    console.error('[getReleasesByLabel] Error:', error);
    return [];
  }
}