// src/pages/api/get-mix-comments.ts
import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

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
    const mixId = url.searchParams.get('mixId');

    if (!mixId) {
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Mix ID required' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const mixDoc = await db.collection('dj-mixes').doc(mixId).get();
    
    if (!mixDoc.exists) {
      return new Response(JSON.stringify({ 
        success: false,
        error: 'Mix not found' 
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const data = mixDoc.data();
    const comments = data?.comments || [];

    log.info(`[get-mix-comments] Mix: ${mixId}, Comments: ${comments.length}`);

    return new Response(JSON.stringify({
      success: true,
      comments: comments,
      count: comments.length
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60' // 1 minute cache
      }
    });

  } catch (error) {
    log.error('[get-mix-comments] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch comments'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};