// src/pages/api/livestream/listeners.ts
// API endpoint for tracking and retrieving active listeners on a live stream

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, deleteDocument, queryCollection, initFirebaseEnv } from '../../../lib/firebase-rest';

export const prerender = false;

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY || 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g',
  });
}

// GET - Retrieve list of active listeners for a stream
export const GET: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  try {
    const url = new URL(request.url);
    const streamId = url.searchParams.get('streamId');
    
    if (!streamId) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Stream ID required' 
      }), { status: 400 });
    }
    
    // Get active listeners from Firestore
    // Listeners are stored with a TTL - only show those active in last 2 minutes
    const twoMinutesAgo = Date.now() - (2 * 60 * 1000);

    // Query by streamId only, then filter by lastSeen in code
    // This avoids needing a composite index
    const results = await queryCollection('stream-listeners', {
      filters: [
        { field: 'streamId', op: 'EQUAL', value: streamId }
      ],
      limit: 100
    });

    // Filter to only recent listeners and map to response format
    const listeners = results
      .filter(data => (data.lastSeen || 0) > twoMinutesAgo)
      .map(data => ({
        id: data.id,
        name: data.userName || 'Anonymous',
        avatarUrl: data.avatarUrl || null,
        joinedAt: data.joinedAt || data.lastSeen
      }))
      .slice(0, 50);
    
    return new Response(JSON.stringify({ 
      success: true, 
      listeners,
      count: listeners.length
    }), { 
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Error fetching listeners:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Failed to fetch listeners',
      listeners: []
    }), { status: 500 });
  }
};

// POST - Join or leave a stream as a listener
export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  try {
    let body;
    
    // Handle both JSON and sendBeacon (text/plain) requests
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      body = await request.json();
    } else {
      const text = await request.text();
      body = JSON.parse(text);
    }
    
    const { action, streamId, userId, userName, avatarUrl } = body;
    
    if (!streamId || !userId) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Stream ID and User ID required' 
      }), { status: 400 });
    }
    
    const listenerId = `${streamId}_${userId}`;

    if (action === 'join') {
      // Add or update listener
      await setDocument('stream-listeners', listenerId, {
        streamId,
        userId,
        userName: userName || 'Anonymous',
        avatarUrl: avatarUrl || null,
        joinedAt: Date.now(),
        lastSeen: Date.now()
      });

      // Increment totalViews on the stream slot (counts every visit, even repeat visits by same user)
      let newTotalViews = 1;
      try {
        const slot = await getDocument('livestreamSlots', streamId);
        if (slot) {
          const currentViews = slot.totalViews || 0;
          newTotalViews = currentViews + 1;
          await updateDocument('livestreamSlots', streamId, {
            totalViews: newTotalViews
          });
        }
      } catch (e) {
        console.log('[listeners] Could not increment totalViews:', e);
      }

      return new Response(JSON.stringify({
        success: true,
        message: 'Joined as listener',
        totalViews: newTotalViews
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } else if (action === 'leave') {
      // Remove listener
      await deleteDocument('stream-listeners', listenerId);

      return new Response(JSON.stringify({
        success: true,
        message: 'Left stream'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } else if (action === 'heartbeat') {
      // Update last seen timestamp - use setDocument to create if doesn't exist
      await setDocument('stream-listeners', listenerId, {
        streamId,
        userId,
        userName: userName || 'Viewer',
        avatarUrl: avatarUrl || null,
        lastSeen: Date.now()
      });

      return new Response(JSON.stringify({
        success: true,
        message: 'Heartbeat received'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } else {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Invalid action. Use: join, leave, or heartbeat' 
      }), { status: 400 });
    }
    
  } catch (error) {
    console.error('Error updating listener:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Failed to update listener status' 
    }), { status: 500 });
  }
};
