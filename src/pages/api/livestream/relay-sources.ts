// src/pages/api/livestream/relay-sources.ts
// API for managing external radio relay sources
import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, deleteDocument, queryCollection, addDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

// GET - List all relay sources or check specific one
export const GET: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  try {
    const url = new URL(request.url);
    const sourceId = url.searchParams.get('id');
    
    if (sourceId) {
      // Get single source
      const doc = await getDocument('relaySources', sourceId);
      if (!doc) {
        return new Response(JSON.stringify({ success: false, error: 'Source not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ success: true, source: doc }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // List all sources
    const sources = await queryCollection('relaySources', {
      orderBy: { field: 'name', direction: 'ASCENDING' }
    });
    
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
export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  try {
    const data = await request.json();
    
    const { name, streamUrl, websiteUrl, logoUrl, genre, description, checkMethod, statusUrl } = data;
    
    if (!name || !streamUrl) {
      return new Response(JSON.stringify({ success: false, error: 'Name and stream URL are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const now = new Date().toISOString();
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
      createdAt: now,
      updatedAt: now
    };

    const { id } = await addDocument('relaySources', sourceData);

    return new Response(JSON.stringify({
      success: true,
      id,
      source: { id, ...sourceData }
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
export const PUT: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
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
    updates.updatedAt = new Date().toISOString();

    await updateDocument('relaySources', id, updates);
    
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
export const DELETE: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    
    if (!id) {
      return new Response(JSON.stringify({ success: false, error: 'Source ID is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    await deleteDocument('relaySources', id);
    
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
