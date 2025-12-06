// src/pages/api/livestream/status.ts
// Check if any stream is currently live and get stream details

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

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
  try {
    const url = new URL(request.url);
    const streamId = url.searchParams.get('streamId');
    
    if (streamId) {
      // Get specific stream
      const streamDoc = await db.collection('livestreams').doc(streamId).get();
      
      if (!streamDoc.exists) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Stream not found'
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      
      return new Response(JSON.stringify({
        success: true,
        stream: { id: streamDoc.id, ...streamDoc.data() }
      }), { 
        status: 200, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    // Check for any live stream
    const liveStreams = await db.collection('livestreams')
      .where('isLive', '==', true)
      .orderBy('startedAt', 'desc')
      .limit(5)
      .get();
    
    if (liveStreams.empty) {
      // Check for scheduled streams
      const now = new Date().toISOString();
      const scheduledStreams = await db.collection('livestreams')
        .where('status', '==', 'scheduled')
        .where('scheduledFor', '>', now)
        .orderBy('scheduledFor', 'asc')
        .limit(3)
        .get();
      
      const scheduled = scheduledStreams.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      
      return new Response(JSON.stringify({
        success: true,
        isLive: false,
        streams: [],
        scheduled
      }), { 
        status: 200, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    const streams = liveStreams.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    return new Response(JSON.stringify({
      success: true,
      isLive: true,
      streams,
      primaryStream: streams[0] // Main featured stream
    }), { 
      status: 200, 
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      } 
    });
    
  } catch (error) {
    console.error('[livestream/status] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to get stream status'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
