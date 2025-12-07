// src/pages/api/livestream/relay-sources.ts
// API for managing external radio relay sources
import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

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

// GET - List all relay sources or check specific one
export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const sourceId = url.searchParams.get('id');
    
    if (sourceId) {
      // Get single source
      const doc = await db.collection('relaySources').doc(sourceId).get();
      if (!doc.exists) {
        return new Response(JSON.stringify({ success: false, error: 'Source not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ success: true, source: { id: doc.id, ...doc.data() } }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // List all sources
    const snapshot = await db.collection('relaySources')
      .orderBy('name')
      .get();
    
    const sources = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    return new Response(JSON.stringify({ success: true, sources }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('Error fetching relay sources:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST - Create new relay source
export const POST: APIRoute = async ({ request }) => {
  try {
    const data = await request.json();
    
    const { name, streamUrl, websiteUrl, logoUrl, genre, description, checkMethod, statusUrl } = data;
    
    if (!name || !streamUrl) {
      return new Response(JSON.stringify({ success: false, error: 'Name and stream URL are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const sourceData = {
      name,
      streamUrl,
      websiteUrl: websiteUrl || '',
      logoUrl: logoUrl || '',
      genre: genre || 'Jungle / D&B',
      description: description || '',
      checkMethod: checkMethod || 'none', // 'none', 'http', 'icecast'
      statusUrl: statusUrl || '',
      active: true,
      isCurrentlyLive: false,
      lastChecked: null,
      nowPlaying: '',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };
    
    const docRef = await db.collection('relaySources').add(sourceData);
    
    return new Response(JSON.stringify({ 
      success: true, 
      id: docRef.id,
      source: { id: docRef.id, ...sourceData }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('Error creating relay source:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// PUT - Update relay source
export const PUT: APIRoute = async ({ request }) => {
  try {
    const data = await request.json();
    const { id, ...updates } = data;
    
    if (!id) {
      return new Response(JSON.stringify({ success: false, error: 'Source ID is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Remove fields that shouldn't be updated directly
    delete updates.createdAt;
    updates.updatedAt = FieldValue.serverTimestamp();
    
    await db.collection('relaySources').doc(id).update(updates);
    
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('Error updating relay source:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// DELETE - Remove relay source
export const DELETE: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    
    if (!id) {
      return new Response(JSON.stringify({ success: false, error: 'Source ID is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    await db.collection('relaySources').doc(id).delete();
    
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('Error deleting relay source:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
