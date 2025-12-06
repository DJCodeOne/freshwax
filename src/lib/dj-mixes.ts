// src/lib/dj-mixes.ts
// Server-side DJ mixes helper - uses Firebase Admin directly during SSR
// Eliminates need for internal API fetch calls

import { db } from '../firebase/server';

// Conditional logging - only logs in development
const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

// Helper function to normalize mix data
function normalizeMix(doc: FirebaseFirestore.DocumentSnapshot): any {
  const data = doc.data();
  if (!data) return null;
  
  return {
    id: doc.id,
    title: data.title || data.name || 'Untitled Mix',
    dj_name: data.dj_name || data.djName || data.artist || 'Unknown DJ',
    artwork_url: data.artwork_url || data.artworkUrl || data.coverUrl || data.imageUrl || '/logo.webp',
    audio_url: data.audio_url || data.audioUrl || data.mp3Url || data.streamUrl || null,
    duration: data.duration || null,
    durationSeconds: data.durationSeconds || data.duration_seconds || null,
    genre: data.genre || data.genres || 'Jungle & D&B',
    description: data.description || '',
    plays: data.playCount || data.plays || 0,
    likes: data.likeCount || data.likes || 0,
    downloads: data.downloadCount || data.downloads || 0,
    commentCount: data.commentCount || (data.comments?.length || 0),
    upload_date: data.upload_date || data.uploadedAt || data.createdAt || new Date().toISOString(),
    published: data.published ?? data.status === 'live' ?? true,
    // Include original data for any additional fields
    ...data
  };
}

// Get all published DJ mixes
export async function getDJMixesForPage(limit: number = 50): Promise<any[]> {
  if (!db) {
    console.warn('[getDJMixesForPage] Firebase not initialized');
    return [];
  }
  
  try {
    log.info(`[getDJMixesForPage] Fetching up to ${limit} mixes...`);
    
    // Try 'published' field first
    let snapshot = await db.collection('dj-mixes')
      .where('published', '==', true)
      .limit(limit)
      .get();
    
    // If no results, try 'status' field
    if (snapshot.empty) {
      snapshot = await db.collection('dj-mixes')
        .where('status', '==', 'live')
        .limit(limit)
        .get();
    }
    
    // If still no results, get all (for backwards compatibility)
    if (snapshot.empty) {
      snapshot = await db.collection('dj-mixes')
        .limit(limit)
        .get();
    }
    
    const mixes: any[] = [];
    
    snapshot.forEach(doc => {
      const normalized = normalizeMix(doc);
      if (normalized) {
        mixes.push(normalized);
      }
    });
    
    // Sort by upload date (newest first)
    mixes.sort((a, b) => {
      const dateA = new Date(a.upload_date || 0).getTime();
      const dateB = new Date(b.upload_date || 0).getTime();
      return dateB - dateA;
    });
    
    log.info(`[getDJMixesForPage] ✓ Returning ${mixes.length} mixes`);
    return mixes;
    
  } catch (error) {
    console.error('[getDJMixesForPage] Error:', error);
    return [];
  }
}

// Get single DJ mix by ID
export async function getDJMixById(mixId: string): Promise<any | null> {
  if (!db) {
    console.warn('[getDJMixById] Firebase not initialized');
    return null;
  }
  
  try {
    log.info(`[getDJMixById] Fetching: ${mixId}`);
    const doc = await db.collection('dj-mixes').doc(mixId).get();
    
    if (!doc.exists) {
      log.info(`[getDJMixById] ✗ Not found: ${mixId}`);
      return null;
    }
    
    const normalized = normalizeMix(doc);
    log.info(`[getDJMixById] ✓ Found: ${normalized?.title}`);
    return normalized;
    
  } catch (error) {
    console.error('[getDJMixById] Error:', error);
    return null;
  }
}

// Get mixes by DJ name
export async function getDJMixesByDJ(djName: string, limit: number = 20): Promise<any[]> {
  if (!db) return [];
  
  try {
    const snapshot = await db.collection('dj-mixes')
      .where('dj_name', '==', djName)
      .limit(limit)
      .get();
    
    const mixes: any[] = [];
    
    snapshot.forEach(doc => {
      const normalized = normalizeMix(doc);
      if (normalized) {
        mixes.push(normalized);
      }
    });
    
    mixes.sort((a, b) => {
      const dateA = new Date(a.upload_date || 0).getTime();
      const dateB = new Date(b.upload_date || 0).getTime();
      return dateB - dateA;
    });
    
    log.info(`[getDJMixesByDJ] Found ${mixes.length} mixes for "${djName}"`);
    return mixes;
    
  } catch (error) {
    console.error('[getDJMixesByDJ] Error:', error);
    return [];
  }
}