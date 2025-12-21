// src/lib/firebase-client.ts
// Client-side Firebase SDK - works everywhere (browser, Cloudflare, etc.)

import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { 
  getFirestore, 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  query, 
  where, 
  orderBy, 
  limit as firestoreLimit,
  updateDoc,
  arrayUnion,
  increment,
  Timestamp,
  type Firestore 
} from 'firebase/firestore';

// Your Firebase config (client-side, these are safe to expose)
// Use environment variables with fallbacks for production
const firebaseConfig = {
  apiKey: import.meta.env.PUBLIC_FIREBASE_API_KEY || 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g',
  authDomain: import.meta.env.PUBLIC_FIREBASE_AUTH_DOMAIN || 'freshwax-store.firebaseapp.com',
  projectId: import.meta.env.PUBLIC_FIREBASE_PROJECT_ID || 'freshwax-store',
  storageBucket: import.meta.env.PUBLIC_FIREBASE_STORAGE_BUCKET || 'freshwax-store.firebasestorage.app',
  messagingSenderId: import.meta.env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID || '675435782973',
  appId: import.meta.env.PUBLIC_FIREBASE_APP_ID || '1:675435782973:web:e8459c2ec4a5f6d683db54'
};

let app: FirebaseApp;
let db: Firestore;

// Initialize Firebase (singleton pattern)
function getFirebaseApp(): FirebaseApp {
  if (!app) {
    const apps = getApps();
    app = apps.length > 0 ? apps[0] : initializeApp(firebaseConfig);
  }
  return app;
}

export function getDb(): Firestore {
  if (!db) {
    db = getFirestore(getFirebaseApp());
  }
  return db;
}

// ============================================
// CLIENT-SIDE CACHE - Reduces Firebase reads for browsers
// ============================================
interface ClientCacheEntry {
  data: any;
  expires: number;
}

const clientCache = new Map<string, ClientCacheEntry>();
const CLIENT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes for client-side

function getClientCached(key: string): any | null {
  const entry = clientCache.get(key);
  if (entry && Date.now() < entry.expires) {
    console.log('[firebase-client] Cache HIT:', key);
    return entry.data;
  }
  if (entry) {
    clientCache.delete(key);
  }
  return null;
}

function setClientCache(key: string, data: any): void {
  clientCache.set(key, {
    data,
    expires: Date.now() + CLIENT_CACHE_TTL
  });
  // Cleanup if too large
  if (clientCache.size > 20) {
    const oldest = clientCache.keys().next().value;
    if (oldest) clientCache.delete(oldest);
  }
}

// ============================================
// READ OPERATIONS
// ============================================

// Get all live releases (CACHED)
export async function getReleases(limitCount: number = 100): Promise<any[]> {
  // Check cache first
  const cacheKey = `releases:${limitCount}`;
  const cached = getClientCached(cacheKey);
  if (cached) return cached;
  
  const db = getDb();
  const q = query(
    collection(db, 'releases'),
    where('status', '==', 'live'),
    firestoreLimit(limitCount)
  );
  
  const snapshot = await getDocs(q);
  const releases = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));
  
  // Sort by releaseDate (newest first)
  releases.sort((a, b) => {
    const dateA = new Date(a.releaseDate || 0).getTime();
    const dateB = new Date(b.releaseDate || 0).getTime();
    return dateB - dateA;
  });
  
  // Cache the results
  setClientCache(cacheKey, releases);
  
  return releases;
}

// Get single release by ID
export async function getRelease(releaseId: string): Promise<any | null> {
  const db = getDb();
  const docRef = doc(db, 'releases', releaseId);
  const docSnap = await getDoc(docRef);
  
  if (!docSnap.exists()) return null;
  
  const data = docSnap.data();
  if (data.status !== 'live') return null;
  
  return {
    id: docSnap.id,
    ...data
  };
}

// Get ratings for a release
export async function getRatings(releaseId: string): Promise<{ average: number; count: number; fiveStarCount: number }> {
  const db = getDb();
  const docRef = doc(db, 'releases', releaseId);
  const docSnap = await getDoc(docRef);
  
  if (!docSnap.exists()) {
    return { average: 0, count: 0, fiveStarCount: 0 };
  }
  
  const data = docSnap.data();
  const ratings = data.ratings || {};
  
  return {
    average: ratings.average || 0,
    count: ratings.count || 0,
    fiveStarCount: ratings.fiveStarCount || 0
  };
}

// Get comments for a release
export async function getComments(releaseId: string): Promise<any[]> {
  const db = getDb();
  const docRef = doc(db, 'releases', releaseId);
  const docSnap = await getDoc(docRef);
  
  if (!docSnap.exists()) return [];
  
  const data = docSnap.data();
  const comments = data.comments || [];
  
  // Sort by timestamp (newest first)
  return [...comments].sort((a, b) => {
    const dateA = new Date(a.timestamp || a.createdAt || 0).getTime();
    const dateB = new Date(b.timestamp || b.createdAt || 0).getTime();
    return dateB - dateA;
  });
}

// Get DJ mixes (CACHED)
export async function getDJMixes(limitCount: number = 50): Promise<any[]> {
  // Check cache first
  const cacheKey = `dj-mixes:${limitCount}`;
  const cached = getClientCached(cacheKey);
  if (cached) return cached;
  
  const db = getDb();
  
  // Try 'published' field first
  let q = query(
    collection(db, 'dj-mixes'),
    where('published', '==', true),
    firestoreLimit(limitCount)
  );
  
  let snapshot = await getDocs(q);
  
  // If no results, try without filter
  if (snapshot.empty) {
    q = query(collection(db, 'dj-mixes'), firestoreLimit(limitCount));
    snapshot = await getDocs(q);
  }
  
  const mixes = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));
  
  // Cache the results
  setClientCache(cacheKey, mixes);
  
  return mixes;
}

// Get single DJ mix
export async function getDJMix(mixId: string): Promise<any | null> {
  const db = getDb();
  const docRef = doc(db, 'dj-mixes', mixId);
  const docSnap = await getDoc(docRef);
  
  if (!docSnap.exists()) return null;
  
  return {
    id: docSnap.id,
    ...docSnap.data()
  };
}

// Get shuffle tracks
export async function getShuffleTracks(limitCount: number = 30): Promise<any[]> {
  const releases = await getReleases(50);
  
  const tracks: any[] = [];
  
  for (const release of releases) {
    const releaseTracks = release.tracks || [];
    
    for (let i = 0; i < releaseTracks.length; i++) {
      const track = releaseTracks[i];
      const audioUrl = track.previewUrl || track.mp3Url || track.audioUrl;
      
      if (audioUrl) {
        tracks.push({
          id: `${release.id}-track-${track.trackNumber || i + 1}`,
          releaseId: release.id,
          title: track.trackName || track.title || track.name || `Track ${i + 1}`,
          artist: release.artistName || release.artist || 'Unknown Artist',
          artwork: release.coverArtUrl || release.artworkUrl || '/place-holder.webp',
          previewUrl: audioUrl,
          duration: track.duration || null
        });
      }
    }
  }
  
  // Shuffle (Fisher-Yates)
  for (let i = tracks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
  }
  
  return tracks.slice(0, limitCount);
}

// Search releases (uses cached releases when available)
export async function searchReleases(searchQuery: string, limitCount: number = 20): Promise<any[]> {
  const query_lower = searchQuery.toLowerCase().trim();
  if (query_lower.length < 2) return [];
  
  // Use 100 releases max for search (cached after first load)
  const releases = await getReleases(100);
  
  const matched = releases.filter(release => {
    const searchFields = [
      release.releaseName,
      release.artistName,
      release.label,
      release.labelName,
      release.recordLabel,
      release.catalogNumber
    ];
    
    for (const field of searchFields) {
      if (field && typeof field === 'string' && field.toLowerCase().includes(query_lower)) {
        return true;
      }
    }
    
    // Check tracks
    for (const track of (release.tracks || [])) {
      const trackName = track.trackName || track.title || track.name;
      if (trackName && trackName.toLowerCase().includes(query_lower)) {
        return true;
      }
    }
    
    return false;
  });
  
  return matched.slice(0, limitCount);
}

// ============================================
// WRITE OPERATIONS
// ============================================

// Add a comment to a release
export async function addComment(
  releaseId: string, 
  comment: { text: string; userId?: string; userName?: string; userEmail?: string }
): Promise<boolean> {
  try {
    const db = getDb();
    const docRef = doc(db, 'releases', releaseId);
    
    await updateDoc(docRef, {
      comments: arrayUnion({
        ...comment,
        timestamp: Timestamp.now(),
        createdAt: new Date().toISOString()
      })
    });
    
    return true;
  } catch (error) {
    console.error('[addComment] Error:', error);
    return false;
  }
}

// Submit a rating
export async function submitRating(
  releaseId: string, 
  rating: number,
  userId?: string
): Promise<boolean> {
  try {
    const db = getDb();
    const docRef = doc(db, 'releases', releaseId);
    
    // Get current ratings
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) return false;
    
    const data = docSnap.data();
    const currentRatings = data.ratings || { average: 0, count: 0, total: 0, fiveStarCount: 0 };
    
    // Calculate new ratings
    const newCount = currentRatings.count + 1;
    const newTotal = currentRatings.total + rating;
    const newAverage = newTotal / newCount;
    const newFiveStarCount = rating === 5 ? (currentRatings.fiveStarCount || 0) + 1 : currentRatings.fiveStarCount || 0;
    
    await updateDoc(docRef, {
      ratings: {
        average: Math.round(newAverage * 10) / 10,
        count: newCount,
        total: newTotal,
        fiveStarCount: newFiveStarCount
      }
    });
    
    return true;
  } catch (error) {
    console.error('[submitRating] Error:', error);
    return false;
  }
}

// Track mix play
export async function trackMixPlay(mixId: string): Promise<boolean> {
  try {
    const db = getDb();
    const docRef = doc(db, 'dj-mixes', mixId);
    
    await updateDoc(docRef, {
      playCount: increment(1)
    });
    
    return true;
  } catch (error) {
    console.error('[trackMixPlay] Error:', error);
    return false;
  }
}

// Track mix like
export async function likeMix(mixId: string, userId: string): Promise<boolean> {
  try {
    const db = getDb();
    const docRef = doc(db, 'dj-mixes', mixId);
    
    await updateDoc(docRef, {
      likeCount: increment(1),
      likedBy: arrayUnion(userId)
    });
    
    return true;
  } catch (error) {
    console.error('[likeMix] Error:', error);
    return false;
  }
}

// Unlike mix
export async function unlikeMix(mixId: string, userId: string): Promise<boolean> {
  try {
    const db = getDb();
    const docRef = doc(db, 'dj-mixes', mixId);
    
    // Get current data
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) return false;
    
    const data = docSnap.data();
    const likedBy = (data.likedBy || []).filter((id: string) => id !== userId);
    
    await updateDoc(docRef, {
      likeCount: increment(-1),
      likedBy
    });
    
    return true;
  } catch (error) {
    console.error('[unlikeMix] Error:', error);
    return false;
  }
}

// Track mix download
export async function trackMixDownload(mixId: string): Promise<boolean> {
  try {
    const db = getDb();
    const docRef = doc(db, 'dj-mixes', mixId);
    
    await updateDoc(docRef, {
      downloadCount: increment(1)
    });
    
    return true;
  } catch (error) {
    console.error('[trackMixDownload] Error:', error);
    return false;
  }
}