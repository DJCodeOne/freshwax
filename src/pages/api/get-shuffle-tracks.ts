// src/pages/api/get-shuffle-tracks.ts
import type { APIRoute } from 'astro';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export const prerender = false;

// Initialize Firebase Admin
if (!getApps().length) {
  try {
    initializeApp({
      credential: cert({
        projectId: import.meta.env.FIREBASE_PROJECT_ID,
        clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
        privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
    console.log('[get-shuffle-tracks] Firebase Admin initialized');
  } catch (e) {
    console.error('[get-shuffle-tracks] Firebase init error:', e);
  }
}

export const GET: APIRoute = async () => {
  try {
    console.log('[get-shuffle-tracks] Fetching tracks...');
    
    const db = getFirestore();
    
    if (!db) {
      throw new Error('Firestore not initialized');
    }
    
    // Fetch published releases with tracks
    const releasesSnap = await db.collection('releases')
      .where('published', '==', true)
      .limit(30)
      .get();
    
    console.log('[get-shuffle-tracks] Found', releasesSnap.size, 'published releases');
    
    const tracks: any[] = [];
    
    releasesSnap.docs.forEach(doc => {
      const release = doc.data();
      const releaseTracks = release.tracks || [];
      
      releaseTracks.forEach((track: any, index: number) => {
        // Check for preview URL - handle various field names
        const audioUrl = track.previewUrl || track.mp3Url || track.audioUrl || null;
        
        if (audioUrl) {
          tracks.push({
            id: doc.id + '-track-' + (track.trackNumber || index + 1),
            releaseId: doc.id,
            // Handle various field names for track title
            title: track.trackName || track.title || track.name || ('Track ' + (index + 1)),
            // Handle various field names for artist
            artist: release.artistName || release.artist || 'Unknown Artist',
            // Handle various field names for artwork
            artwork: release.coverArtUrl || release.artworkUrl || '/logo.webp',
            previewUrl: audioUrl
          });
        }
      });
    });
    
    console.log('[get-shuffle-tracks] Found', tracks.length, 'tracks with audio URLs');
    
    if (tracks.length === 0) {
      console.log('[get-shuffle-tracks] No tracks with audio found. Check that releases have previewUrl or mp3Url in their tracks array.');
    }
    
    // Shuffle the tracks (Fisher-Yates)
    for (let i = tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
    }
    
    // Return max 30 tracks
    const result = tracks.slice(0, 30);
    
    console.log('[get-shuffle-tracks] ✓ Returning', result.length, 'shuffled tracks');
    
    return new Response(JSON.stringify({
      success: true,
      tracks: result
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300' // Cache for 5 minutes
      }
    });
    
  } catch (error: any) {
    console.error('[get-shuffle-tracks] Error:', error);
    
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Failed to fetch tracks',
      tracks: []
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};