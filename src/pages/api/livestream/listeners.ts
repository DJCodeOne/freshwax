// src/pages/api/livestream/listeners.ts
// API endpoint for tracking and retrieving active listeners on a live stream

import type { APIRoute } from 'astro';
import { adminDb } from '../../../lib/firebase-admin';

export const prerender = false;

// GET - Retrieve list of active listeners for a stream
export const GET: APIRoute = async ({ request }) => {
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
    
    const listenersRef = adminDb.collection('stream-listeners');
    const snapshot = await listenersRef
      .where('streamId', '==', streamId)
      .where('lastSeen', '>', twoMinutesAgo)
      .orderBy('lastSeen', 'desc')
      .limit(50)
      .get();
    
    const listeners = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data.userName || 'Anonymous',
        avatarUrl: data.avatarUrl || null,
        joinedAt: data.joinedAt || data.lastSeen
      };
    });
    
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
export const POST: APIRoute = async ({ request }) => {
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
    
    const listenersRef = adminDb.collection('stream-listeners');
    const listenerId = `${streamId}_${userId}`;
    
    if (action === 'join') {
      // Add or update listener
      await listenersRef.doc(listenerId).set({
        streamId,
        userId,
        userName: userName || 'Anonymous',
        avatarUrl: avatarUrl || null,
        joinedAt: Date.now(),
        lastSeen: Date.now()
      }, { merge: true });
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'Joined as listener' 
      }), { 
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } else if (action === 'leave') {
      // Remove listener
      await listenersRef.doc(listenerId).delete();
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'Left stream' 
      }), { 
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } else if (action === 'heartbeat') {
      // Update last seen timestamp
      await listenersRef.doc(listenerId).update({
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
