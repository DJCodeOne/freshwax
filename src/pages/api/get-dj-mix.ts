// src/pages/api/get-dj-mix.ts
// MATCHES get-releases.ts pattern exactly
import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export const prerender = false;

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

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  if (!id) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Mix ID is required'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    console.log(`[GET-DJ-MIX] Fetching mix with ID: ${id}`);
    
    // Use the correct collection name: 'dj-mixes' (with hyphen, not underscore)
    const doc = await db.collection('dj-mixes').doc(id).get();
    
    if (!doc.exists) {
      console.log(`[GET-DJ-MIX] ✗ Mix not found with ID: ${id}`);
      return new Response(JSON.stringify({
        success: false,
        error: 'Mix not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const data = doc.data();
    const mix = {
      id: doc.id,
      ...data,
      plays: data.plays || 0,
      downloads: data.downloads || 0,
      likes: data.likes || 0,
      title: data.title || data.mixTitle || 'Untitled Mix',
      dj_name: data.dj_name || data.djName || 'Unknown DJ',
      artwork_url: data.artwork_url || data.artworkUrl || '/logo.webp',
      audio_url: data.audio_url || data.audioUrl || '',
      description: data.description || '',
      genre: data.genre || 'Jungle & Drum and Bass',
      upload_date: data.upload_date || data.uploadedAt || data.createdAt || new Date().toISOString(),
      duration: data.duration || '',
      tracklist: data.tracklist || []
    };
    
    console.log(`[GET-DJ-MIX] ✓ Found: ${mix.title} by ${mix.dj_name}`);
    
    return new Response(JSON.stringify({
      success: true,
      mix
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300'
      }
    });
    
  } catch (error) {
    console.error('[GET-DJ-MIX] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch mix',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};