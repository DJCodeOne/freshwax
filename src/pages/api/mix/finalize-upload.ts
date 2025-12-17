// src/pages/api/mix/finalize-upload.ts
// Finalizes a DJ mix upload after direct R2 upload completes
// Saves metadata to Firebase

import type { APIRoute } from 'astro';
import { getDocument, setDocument, initFirebaseEnv, invalidateMixesCache } from '../../../lib/firebase-rest';

export const prerender = false;

// Parse tracklist into array
function parseTracklist(tracklist: string): string[] {
  if (!tracklist || !tracklist.trim()) return [];
  return tracklist.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      return line.replace(/^\d+[\.\)\:\-]?\s*[-–—]?\s*/, '').trim();
    })
    .filter(line => line.length > 0);
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const body = await request.json();
    const {
      mixId,
      audioUrl,
      artworkUrl,
      folderPath,
      djName,
      mixTitle,
      mixDescription,
      genre,
      tracklist,
      durationSeconds,
      userId,
    } = body;

    if (!mixId || !audioUrl) {
      return new Response(JSON.stringify({
        success: false,
        error: 'mixId and audioUrl are required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get user's display name from profile
    let displayName = djName || 'Unknown DJ';
    if (userId) {
      try {
        let userData = await getDocument('customers', userId);
        if (userData?.displayName) {
          displayName = userData.displayName;
        } else {
          userData = await getDocument('users', userId);
          if (userData?.displayName) {
            displayName = userData.displayName;
          }
        }
      } catch (e) {
        console.log('[finalize-upload] Could not fetch user data, using provided name');
      }
    }

    const uploadDate = new Date().toISOString();
    const tracklistArray = parseTracklist(tracklist || '');

    // Use placeholder artwork if not provided
    const finalArtworkUrl = artworkUrl || '/place-holder.webp';

    // Save mix metadata to Firebase
    const mixData = {
      id: mixId,
      title: (mixTitle || 'Untitled Mix').slice(0, 50),
      name: (mixTitle || 'Untitled Mix').slice(0, 50),
      djName: displayName.slice(0, 30),
      dj_name: displayName.slice(0, 30),
      displayName: displayName.slice(0, 30),
      description: (mixDescription || '').slice(0, 150),
      shoutOuts: (mixDescription || '').slice(0, 150),
      genre: (genre || 'Jungle').slice(0, 30),
      tracklist: tracklist || '',
      tracklistArray,
      trackCount: tracklistArray.length,
      durationSeconds: durationSeconds || 0,
      durationFormatted: formatDuration(durationSeconds || 0),
      duration: formatDuration(durationSeconds || 0),
      audio_url: audioUrl,
      audioUrl: audioUrl,
      mp3Url: audioUrl,
      artworkUrl: finalArtworkUrl,
      imageUrl: finalArtworkUrl,
      artwork_url: finalArtworkUrl,
      folder_path: folderPath,
      userId: userId || '',
      upload_date: uploadDate,
      uploadedAt: uploadDate,
      createdAt: uploadDate,
      updatedAt: uploadDate,
      published: true,
      allowDownload: true,
      featured: false,
      plays: 0,
      likes: 0,
      downloads: 0,
      playCount: 0,
      likeCount: 0,
      downloadCount: 0,
      commentCount: 0,
      comments: [],
      ratings: { average: 0, count: 0 },
    };

    await setDocument('dj-mixes', mixId, mixData);
    console.log(`[finalize-upload] Mix saved: ${mixId}`);

    // Clear cache so new mix appears immediately
    invalidateMixesCache();

    return new Response(JSON.stringify({
      success: true,
      mixId,
      message: 'Mix uploaded successfully'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[finalize-upload] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '0:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
