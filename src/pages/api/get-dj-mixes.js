// src/pages/api/get-dj-mixes.js
// SIMPLIFIED: Remove compound query to avoid index requirement
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

export async function GET({ request }) {
  const url = new URL(request.url);
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? parseInt(limitParam) : 50;
  
  console.log(`[GET-DJ-MIXES] Fetching DJ mixes from Firebase...`);
  
  try {
    // SIMPLIFIED: Just order by date, filter published client-side
    const mixesSnapshot = await db.collection('dj-mixes')
      .orderBy('uploadedAt', 'desc')
      .limit(limit)
      .get();
    
    console.log(`[GET-DJ-MIXES] Found ${mixesSnapshot.size} documents`);
    
    const mixes = [];
    mixesSnapshot.forEach(doc => {
      const data = doc.data();
      
      // Filter for published and live status
      if (data.published === true && data.status === 'live') {
        mixes.push({
          id: doc.id,
          dj_name: data.djName || data.dj_name || 'Unknown DJ',
          title: data.title || data.mixTitle || 'Untitled Mix',
          description: data.description || '',
          audio_url: data.audioUrl || data.audio_url || '',
          artwork_url: data.artworkUrl || data.artwork_url || '/logo.webp',
          upload_date: data.uploadedAt || data.upload_date || data.createdAt || new Date().toISOString(),
          duration: data.duration || '',
          genre: data.genre || 'Jungle & Drum and Bass',
          plays: data.plays || 0,
          downloads: data.downloads || 0,
          likes: data.likes || 0
        });
      }
    });
    
    console.log(`[GET-DJ-MIXES] ✓ Returning ${mixes.length} published mixes`);
    
    return new Response(JSON.stringify({ 
      success: true,
      mixes: mixes,
      totalMixes: mixes.length
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300'
      }
    });
    
  } catch (error) {
    console.error('[GET-DJ-MIXES] ✗ Error:', error);
    return new Response(JSON.stringify({ 
      success: false,
      error: 'Failed to fetch DJ mixes',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}